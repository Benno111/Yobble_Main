import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth, requireRole } from "../auth.js";
import { run, all, get } from "../db.js";
import { moderateText, ModerationSeverity } from "../ai-moderation.js";
import { scanAndRemoveBadChatMessages } from "./chat.js";
import { scanUploadedImage } from "../image-moderation.js";

export const reportsRouter = express.Router();

const SERVER_DIR = path.resolve(process.cwd());
const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
const TMP_DIR = path.join(PROJECT_ROOT, "save", "uploads", "report_evidence");
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }
});

function canAutoAct(severity) {
  return [ModerationSeverity.MEDIUM, ModerationSeverity.HIGH].includes(severity);
}

async function resolveReportAi(reportId, action, note) {
  const ts = Date.now();
  await run(
    `UPDATE reports
     SET status='resolved',
         resolved_by=NULL,
         resolved_at=?,
         resolution_note=?,
         ai_action=?,
         ai_note=?,
         ai_reviewed_at=?
     WHERE id=?`,
    [ts, note, action, note, ts, reportId]
  );
}

async function markReportAiReviewed(reportId, priority, action, note) {
  await run(
    `UPDATE reports
     SET ai_priority=?,
         ai_action=?,
         ai_note=?,
         ai_reviewed_at=?
     WHERE id=?`,
    [priority, action, note, Date.now(), reportId]
  );
}

async function findChatRoomRef(targetRef) {
  const byUuid = await get(
    "SELECT channel_uuid, name FROM chat_channels WHERE channel_uuid=? AND is_dm=0",
    [targetRef]
  );
  if (byUuid) return byUuid;
  return get(
    "SELECT channel_uuid, name FROM chat_channels WHERE name=? AND is_dm=0",
    [targetRef]
  );
}

async function reviewReportAndTakeAction(report) {
  const reasonPrefix = report.category ? `Report category: ${report.category}\n` : "";

  if (report.target_type === "chat_message") {
    const message = await get(
      "SELECT id, text, deleted FROM chat_messages WHERE id=?",
      [Number(report.target_ref)]
    );
    if (!message) {
      await markReportAiReviewed(report.id, null, "target_missing", "Target chat message no longer exists.");
      return;
    }
    const aiResult = await moderateText(
      `${reasonPrefix}Report message: ${report.message}\nTarget chat message: ${message.text || ""}`
    );
    const priority = aiResult.flagged ? aiResult.severity : null;
    if (canAutoAct(aiResult.severity) && !message.deleted) {
      await run("UPDATE chat_messages SET deleted=1 WHERE id=?", [message.id]);
      await resolveReportAi(report.id, "removed_chat_message", `[AI] ${aiResult.reason || "Removed reported chat message."}`);
      return;
    }
    await markReportAiReviewed(report.id, priority, "manual_review", aiResult.reason || "No automatic action taken.");
    return;
  }

  if (report.target_type === "chat_room") {
    const room = await findChatRoomRef(String(report.target_ref || "").trim());
    if (!room) {
      await markReportAiReviewed(report.id, null, "target_missing", "Target chat room no longer exists.");
      return;
    }
    const aiResult = await moderateText(`${reasonPrefix}Report message: ${report.message}\nTarget type: chat_room`);
    const priority = aiResult.flagged ? aiResult.severity : null;
    if (canAutoAct(aiResult.severity)) {
      const result = await scanAndRemoveBadChatMessages({ channelUuid: room.channel_uuid, limit: 5000 });
      if (result.removed.length > 0) {
        await resolveReportAi(
          report.id,
          "removed_chat_room_messages",
          `[AI] Removed ${result.removed.length} flagged messages from room ${room.name}.`
        );
        return;
      }
    }
    await markReportAiReviewed(report.id, priority, "manual_review", aiResult.reason || "No automatic action taken.");
    return;
  }

  if (report.target_type === "game") {
    const game = await get(
      "SELECT id, title, description, is_hidden FROM games WHERE project=?",
      [String(report.target_ref || "").trim()]
    );
    if (!game) {
      await markReportAiReviewed(report.id, null, "target_missing", "Target game no longer exists.");
      return;
    }
    const aiResult = await moderateText(
      `${reasonPrefix}Report message: ${report.message}\nGame title: ${game.title || ""}\nGame description: ${game.description || ""}`
    );
    const priority = aiResult.flagged ? aiResult.severity : null;
    if (aiResult.severity === ModerationSeverity.HIGH && !game.is_hidden) {
      await run("UPDATE games SET is_hidden=1 WHERE id=?", [game.id]);
      await resolveReportAi(report.id, "hid_game", `[AI] ${aiResult.reason || "Game hidden automatically."}`);
      return;
    }
    await markReportAiReviewed(report.id, priority, "manual_review", aiResult.reason || "No automatic action taken.");
    return;
  }

  if (report.target_type === "item") {
    const item = await get(
      "SELECT id, code, name, description, approval_status FROM items WHERE code=?",
      [String(report.target_ref || "").trim()]
    );
    if (!item) {
      await markReportAiReviewed(report.id, null, "target_missing", "Target item no longer exists.");
      return;
    }
    const aiResult = await moderateText(
      `${reasonPrefix}Report message: ${report.message}\nItem name: ${item.name || ""}\nItem description: ${item.description || ""}`
    );
    const priority = aiResult.flagged ? aiResult.severity : null;
    if (aiResult.severity === ModerationSeverity.HIGH) {
      await run(
        `UPDATE items
         SET approval_status='rejected',
             rejected_reason=?,
             approved_by=NULL,
             approved_at=NULL
         WHERE id=?`,
        [aiResult.reason || "ai_report_action", item.id]
      );
      await resolveReportAi(report.id, "rejected_item", `[AI] ${aiResult.reason || "Item rejected automatically."}`);
      return;
    }
    await markReportAiReviewed(report.id, priority, "manual_review", aiResult.reason || "No automatic action taken.");
    return;
  }

  const aiResult = await moderateText(`${reasonPrefix}Report message: ${report.message}\nTarget type: ${report.target_type}`);
  const priority = aiResult.flagged ? aiResult.severity : null;
  await markReportAiReviewed(report.id, priority, "manual_review", aiResult.reason || "No automatic action rule for this report type.");
}

async function createReport(req, res){
  const { target_type, target_ref, category, message } = req.body || {};
  if(!target_type || !["user","game","item","listing","trade","chat_message","chat_room"].includes(target_type)){
    return res.status(400).json({ error:"bad_request" });
  }

  const ref = String(target_ref || "").trim();
  const cat = String(category || "").trim();
  const msg = String(message || "").trim();
  if(!ref || !msg){
    return res.status(400).json({ error:"missing_fields" });
  }

  const result = await run(
    `INSERT INTO reports
     (reporter_id,target_type,target_ref,category,message,created_at,ai_priority)
     VALUES(?,?,?,?,?,?,?)`,
    [req.user.uid, target_type, ref, cat || null, msg, Date.now(), null]
  );
  try {
    await reviewReportAndTakeAction({
      id: result.lastID,
      target_type,
      target_ref: ref,
      category: cat || null,
      message: msg
    });
  } catch (err) {
    console.error("[ai-moderation] report action failed:", err?.message ?? err);
    await markReportAiReviewed(result.lastID, null, "error", err?.message || "AI review failed.");
  }
  res.json({ ok:true, report_id: result.lastID });
}

reportsRouter.post("/", requireAuth, createReport);
reportsRouter.post("/submit", requireAuth, createReport);

reportsRouter.post("/evidence", requireAuth, upload.single("file"), async (req,res)=>{
  const report_id = Number(req.body?.report_id);
  if(!Number.isFinite(report_id) || !req.file){
    return res.status(400).json({ error:"bad_request" });
  }

  const imageScan = await scanUploadedImage({
    file: req.file,
    uploaderId: req.user.uid,
    context: `report evidence upload; report_id=${report_id}`
  });
  if (imageScan.blocked) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({
      error: "bad_image_blocked",
      reason: imageScan.reason || "content_policy_violation",
      punishment: imageScan.punishment || null
    });
  }

  await run(
    `INSERT INTO report_evidence(report_id,filename,stored_path,uploaded_at)
     VALUES(?,?,?,?)`,
    [report_id, req.file.originalname, req.file.path, Date.now()]
  );
  res.json({ ok:true });
});

reportsRouter.get("/mod", requireAuth, requireRole("moderator"), async (_req,res)=>{
  const rows = await all(`
    SELECT r.*, u.username
    FROM reports r
    JOIN users u ON u.id=r.reporter_id
    WHERE r.status='open'
    ORDER BY
      CASE r.ai_priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      r.created_at
  `);
  res.json({reports:rows});
});

reportsRouter.post("/mod/resolve", requireAuth, requireRole("moderator"), async (req,res)=>{
  const { id, note } = req.body;
  await run(
    `UPDATE reports SET status='resolved',
     resolved_by=?, resolved_at=?, resolution_note=? WHERE id=?`,
    [req.user.uid, Date.now(), note||"", id]
  );
  res.json({ok:true});
});

reportsRouter.post("/mod/dismiss", requireAuth, requireRole("moderator"), async (req,res)=>{
  const { id, note } = req.body;
  await run(
    `UPDATE reports SET status='dismissed',
     resolved_by=?, resolved_at=?, resolution_note=? WHERE id=?`,
    [req.user.uid, Date.now(), note||"", id]
  );
  res.json({ok:true});
});
