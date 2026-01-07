import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP = Object.fromEntries(
  BASE32_ALPHABET.split("").map((c, i) => [c, i])
);

function normalizeBase32(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
}

function base32ToBytes(input) {
  const data = normalizeBase32(input);
  if (!data) return null;
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const ch of data) {
    const idx = BASE32_LOOKUP[ch];
    if (idx == null) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(bytes);
}

function bytesToBase32(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function generateTotpSecret(bytes = 20) {
  return bytesToBase32(crypto.randomBytes(bytes));
}

function totpAt(secret, counter, digits = 6) {
  const key = base32ToBytes(secret);
  if (!key) return null;
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, "0");
}

export function verifyTotp(secret, code, window = 1) {
  const cleaned = String(code || "").replace(/\s+/g, "");
  if (!cleaned || !/^\d{6}$/.test(cleaned)) return false;
  const now = Date.now();
  const step = 30;
  const counter = Math.floor(now / 1000 / step);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = totpAt(secret, counter + offset);
    if (expected && expected === cleaned) return true;
  }
  return false;
}

export function buildTotpUri(username, secret, issuer = "Yobble") {
  const label = `${issuer}:${username}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
