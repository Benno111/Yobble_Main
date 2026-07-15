import fs from "fs";
import { run } from "./db.js";
import { ModerationSeverity } from "./ai-moderation.js";

const MODEL = process.env.OLLAMA_IMAGE_MODEL || process.env.OLLAMA_MODEL || "gemma4:e2b";
const BASE_URL = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
const MAX_PIXELS = 36_000_000;
const MEDIUM_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

const IMAGE_SYSTEM_INSTRUCTION = `You are a strict image moderation AI for a game-sharing platform whose audience includes minors.

Analyse the provided image and return ONLY one valid JSON object. Do not return markdown, code fences, commentary, or any text before or after the JSON.

Return this exact JSON shape:
{
  "flagged": false,
  "severity": "none",
  "reason": "",
  "categories": []
}

Rules:
- "flagged" must be a JSON boolean.
- "severity" must be exactly one of "none", "low", "medium", or "high".
- "reason" must be a short plain string.
- "categories" must be a JSON array of strings.
- Do not include extra keys.

Severity guide:
  none   - clean image
  low    - borderline or mildly inappropriate
  medium - clearly inappropriate for minors, explicit adult nudity, graphic violence, harassment, hate imagery
  high   - illegal or zero-tolerance content, CSAM, sexualized minors, credible threats, doxxing, extreme hate content

Be conservative about false positives, but strict about sexual content involving minors, hate symbols, doxxing, and extreme violence.`;

function cleanResult() {
  return {
    blocked: false,
    flagged: false,
    severity: ModerationSeverity.NONE,
    reason: "",
    categories: [],
    source: "local"
  };
}

function normalizeSeverity(value) {
  return Object.values(ModerationSeverity).includes(value) ? value : ModerationSeverity.NONE;
}

function extractJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const withoutFences = text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (withoutFences.startsWith("{") && withoutFences.endsWith("}")) return withoutFences;
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  return start >= 0 && end > start ? withoutFences.slice(start, end + 1) : "";
}

function normalizeAiResult(parsed) {
  const severity = normalizeSeverity(parsed?.severity);
  return {
    blocked: [ModerationSeverity.MEDIUM, ModerationSeverity.HIGH].includes(severity),
    flagged: !!parsed?.flagged || severity !== ModerationSeverity.NONE,
    severity,
    reason: typeof parsed?.reason === "string" ? parsed.reason.slice(0, 500) : "",
    categories: Array.isArray(parsed?.categories)
      ? parsed.categories.filter((c) => typeof c === "string").slice(0, 20)
      : [],
    source: "ai"
  };
}

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return "image/gif";
  }
  return "";
}

function getImageDimensions(buffer, mime) {
  if (mime === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (mime === "image/webp" && buffer.length >= 30) {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const b0 = buffer[21], b1 = buffer[22], b2 = buffer[23], b3 = buffer[24];
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      };
    }
  }
  return null;
}

function localScan(buffer, declaredMime) {
  const detectedMime = detectImageType(buffer);
  if (!detectedMime) {
    return { ...cleanResult(), blocked: true, flagged: true, severity: ModerationSeverity.MEDIUM, reason: "invalid_image_file" };
  }
  if (declaredMime && declaredMime.startsWith("image/") && declaredMime !== detectedMime) {
    return { ...cleanResult(), blocked: true, flagged: true, severity: ModerationSeverity.MEDIUM, reason: "image_type_mismatch" };
  }
  const dimensions = getImageDimensions(buffer, detectedMime);
  if (dimensions) {
    const pixels = dimensions.width * dimensions.height;
    if (pixels > MAX_PIXELS) {
      return { ...cleanResult(), blocked: true, flagged: true, severity: ModerationSeverity.MEDIUM, reason: "image_too_large" };
    }
  }
  return { ...cleanResult(), mime: detectedMime, dimensions };
}

async function aiScanImage(buffer, mime, context) {
  try {
    const response = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: "json",
        options: { temperature: 0.1, num_predict: 256 },
        messages: [
          { role: "system", content: IMAGE_SYSTEM_INSTRUCTION },
          {
            role: "user",
            content: `Moderate this uploaded ${mime || "image"}.\nContext: ${String(context || "user image upload").slice(0, 1000)}`,
            images: [buffer.toString("base64")]
          }
        ]
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      console.error(`[image-moderation] Ollama returned HTTP ${response.status}`);
      return cleanResult();
    }
    const data = await response.json();
    const jsonStr = extractJsonObject(data?.message?.content);
    if (!jsonStr) return cleanResult();
    return normalizeAiResult(JSON.parse(jsonStr));
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      console.error("[image-moderation] request timed out");
    } else {
      console.error("[image-moderation] error:", err?.message ?? err);
    }
    return cleanResult();
  }
}

export async function punishImageUploader(userId, severity, reason) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const normalized = normalizeSeverity(severity);
  if (![ModerationSeverity.MEDIUM, ModerationSeverity.HIGH].includes(normalized)) return null;

  const now = Date.now();
  const note = String(reason || "bad_image_upload").slice(0, 500);
  const expiresAt = normalized === ModerationSeverity.HIGH ? null : now + MEDIUM_TIMEOUT_MS;

  await run(
    `INSERT INTO bans(target_type,target_id,reason,created_at,expires_at)
     VALUES('user',?,?,?,?)`,
    [uid, note, now, expiresAt]
  );

  if (expiresAt) {
    await run(
      `UPDATE users
       SET is_banned=0, timeout_until=?, timeout_reason=?
       WHERE id=?`,
      [expiresAt, note, uid]
    );
    return { type: "timeout", until: expiresAt };
  }

  await run(
    `UPDATE users
     SET is_banned=1, ban_reason=?, banned_at=?,
         timeout_until=NULL, timeout_reason=NULL
     WHERE id=?`,
    [note, now, uid]
  );
  return { type: "permanent" };
}

export async function scanUploadedImage({ file, buffer, declaredMime, uploaderId, context }) {
  const imageBuffer = buffer || file?.buffer || (file?.path ? fs.readFileSync(file.path) : null);
  if (!imageBuffer?.length) return cleanResult();

  const mime = declaredMime || file?.mimetype || "";
  if (mime && !mime.startsWith("image/")) return cleanResult();

  const local = localScan(imageBuffer, mime);
  if (local.blocked) {
    return { ...local, punishment: null };
  }

  const ai = await aiScanImage(imageBuffer, local.mime || mime, context);
  if (ai.blocked) {
    const punishment = await punishImageUploader(uploaderId, ai.severity, ai.reason || "bad_image_upload");
    return { ...ai, punishment };
  }

  return { ...ai, mime: local.mime, dimensions: local.dimensions };
}
