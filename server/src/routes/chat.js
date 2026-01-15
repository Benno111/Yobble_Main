import fs from "fs";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";
import multer from "multer";
import crypto from "crypto";
import { all, get, run } from "../db.js";
import { requireAuth, verifyToken } from "../auth.js";

const DEFAULT_ROOMS = ["general", "rules", "announcements", "offtopic"];
const MAX_MESSAGE_LENGTH = 2000;
const MAX_ATTACHMENTS = 5;

function sanitizeRoom(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return "";
  return trimmed;
}

function isDmChannel(channel) {
  return channel.startsWith("dm:");
}

function dmParticipants(channel) {
  return channel.slice(3).split(",");
}

async function ensureDefaultRooms() {
  const ts = Date.now();
  for (const name of DEFAULT_ROOMS) {
    const exists = await get(
      "SELECT channel_uuid FROM chat_channels WHERE name = ? AND is_dm = 0 LIMIT 1",
      [name]
    );
    if (exists) continue;
    await run(
      `INSERT INTO chat_channels
       (channel_uuid, name, is_dm, created_at, created_by)
       VALUES (?, ?, 0, ?, ?)`,
      [crypto.randomUUID(), name, ts, "system"]
    );
  }
}

async function loadRooms() {
  await ensureDefaultRooms();
  return all("SELECT channel_uuid, name FROM chat_channels WHERE is_dm = 0 ORDER BY name");
}

async function getChannelById(channelUuid) {
  return get(
    "SELECT channel_uuid, name, is_dm FROM chat_channels WHERE channel_uuid = ?",
    [channelUuid]
  );
}

async function getChannelByName(name, isDm = null) {
  if (isDm === null) {
    return get(
      "SELECT channel_uuid, name, is_dm FROM chat_channels WHERE name = ? LIMIT 1",
      [name]
    );
  }
  return get(
    "SELECT channel_uuid, name, is_dm FROM chat_channels WHERE name = ? AND is_dm = ? LIMIT 1",
    [name, isDm ? 1 : 0]
  );
}

async function ensureChannelMember(channelUuid, username, ts) {
  if (!channelUuid || !username) return;
  await run(
    "INSERT OR IGNORE INTO chat_channel_members (channel_uuid, username, added_at) VALUES (?, ?, ?)",
    [channelUuid, username, ts]
  );
}

async function ensureDmChannel(channel, username) {
  if (!isDmChannel(channel)) return null;
  const members = dmParticipants(channel);
  if (!members.includes(username)) return null;
  let row = await getChannelByName(channel, true);
  const ts = Date.now();
  if (!row) {
    await run(
      `INSERT OR IGNORE INTO chat_channels
       (channel_uuid, name, is_dm, created_at, created_by)
       VALUES (?, ?, 1, ?, ?)`,
      [crypto.randomUUID(), channel, ts, username]
    );
    row = await getChannelByName(channel, true);
  }
  if (row) {
    for (const member of members) {
      await ensureChannelMember(row.channel_uuid, member, ts);
    }
  }
  return row;
}

function normalizeChannel(input, rooms) {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return rooms[0]?.channel_uuid || "";
  if (isDmChannel(trimmed)) return trimmed;
  return trimmed;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function createChatRouter({ projectRoot }) {
  const router = express.Router();

  const uploadDir = path.join(projectRoot, "server", "uploads", "chat");
  ensureDir(uploadDir);

  const upload = multer({ dest: uploadDir });

  router.get("/rooms", requireAuth, async (req, res) => {
    const { username } = req.user;
    try {
      const rooms = await loadRooms();
      const ts = Date.now();
      for (const room of rooms) {
        await ensureChannelMember(room.channel_uuid, username, ts);
      }
      res.json({
        rooms: rooms.map((room) => ({
          id: room.channel_uuid,
          name: room.name
        }))
      });
    } catch (err) {
      console.error("chat rooms error", err);
      res.status(500).json({ error: "server_error" });
    }
  });

  router.post("/rooms", requireAuth, async (req, res) => {
    const { username } = req.user;
    const name = sanitizeRoom(req.body?.name || "");
    if (!name) return res.status(400).json({ error: "invalid_room" });
    if (name.length > 32) return res.status(400).json({ error: "name_too_long" });
    if (name.startsWith("dm:")) return res.status(400).json({ error: "invalid_room" });

    try {
      const ts = Date.now();
      const channelUuid = crypto.randomUUID();
      await run(
        `INSERT INTO chat_channels
         (channel_uuid, name, is_dm, created_at, created_by)
         VALUES (?, ?, 0, ?, ?)`,
        [channelUuid, name, ts, username]
      );
      const channel = await getChannelById(channelUuid);
      if (channel) await ensureChannelMember(channel.channel_uuid, username, ts);
      const rooms = await loadRooms();
      return res.json({
        created: channel
          ? { id: channel.channel_uuid, name: channel.name }
          : null,
        rooms: rooms.map((room) => ({
          id: room.channel_uuid,
          name: room.name
        }))
      });
    } catch (err) {
      console.error("chat rooms save error", err);
      return res.status(500).json({ error: "server_error" });
    }
  });

  router.get("/messages", requireAuth, async (req, res) => {
    const { username } = req.user;
    const roomRows = await loadRooms();
    const channelId = normalizeChannel(req.query.channel, roomRows);
    let channelRow = null;
    let channelName = "";
    if (isDmChannel(channelId)) {
      const dmChannel = await ensureDmChannel(channelId, username);
      if (!dmChannel) return res.status(403).json({ error: "not_allowed" });
      channelRow = dmChannel;
      channelName = dmChannel.name;
    } else {
      channelRow = roomRows.find((room) => room.channel_uuid === channelId)
        || await getChannelById(channelId)
        || await getChannelByName(channelId, false)
        || roomRows[0];
      if (!channelRow) return res.status(403).json({ error: "not_allowed" });
      channelName = channelRow.name;
      await ensureChannelMember(channelRow.channel_uuid, username, Date.now());
    }
    const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : null;
    const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);

    let sql = `
      SELECT id, user, text, ts, deleted, channel, channel_uuid
      FROM chat_messages
      WHERE channel_uuid = ? AND deleted = 0
    `;
    const params = [channelRow.channel_uuid];
    if (beforeId) {
      sql += " AND id < ?";
      params.push(beforeId);
    }
    sql += " ORDER BY id DESC LIMIT ?";
    params.push(limit);

    try {
      const rows = await all(sql, params);
      const messageIds = rows.map((row) => row.id);
      let attachRows = [];
      if (messageIds.length) {
        const placeholders = messageIds.map(() => "?").join(",");
        attachRows = await all(
          `SELECT id, message_id, stored_name, original_name, mime, size
           FROM chat_attachments
           WHERE message_id IN (${placeholders})`,
          messageIds
        );
      }
      const attachMap = new Map();
      attachRows.forEach((row) => {
        const list = attachMap.get(row.message_id) || [];
        list.push({
          id: row.id,
          url: "/api/chat/uploads/" + encodeURIComponent(row.stored_name),
          downloadUrl: "/api/chat/attachments/" + row.id + "/download",
          name: row.original_name,
          mime: row.mime,
          size: row.size,
          isImage: (row.mime || "").startsWith("image/"),
          isVideo: (row.mime || "").startsWith("video/")
        });
        attachMap.set(row.message_id, list);
      });
      const messages = rows
        .map((row) => ({
          ...row,
          attachments: attachMap.get(row.id) || []
        }))
        .reverse();
      return res.json({ messages });
    } catch (err) {
      console.error("chat messages error", err);
      return res.status(500).json({ error: "server_error" });
    }
  });

  router.post("/messages", requireAuth, upload.array("files", MAX_ATTACHMENTS), async (req, res) => {
    const { username } = req.user;
    const roomRows = await loadRooms();
    const channelId = normalizeChannel(req.body?.channel, roomRows);
    let channelRow = null;
    let channelName = "";
    if (isDmChannel(channelId)) {
      const dmChannel = await ensureDmChannel(channelId, username);
      if (!dmChannel) return res.status(403).json({ error: "not_allowed" });
      channelRow = dmChannel;
      channelName = dmChannel.name;
    } else {
      channelRow = roomRows.find((room) => room.channel_uuid === channelId)
        || await getChannelById(channelId)
        || await getChannelByName(channelId, false)
        || roomRows[0];
      if (!channelRow) return res.status(403).json({ error: "not_allowed" });
      channelName = channelRow.name;
      await ensureChannelMember(channelRow.channel_uuid, username, Date.now());
    }
    const text = String(req.body?.text || "").trim().slice(0, MAX_MESSAGE_LENGTH);
    const files = Array.isArray(req.files) ? req.files : [];
    if (!text && !files.length) {
      return res.status(400).json({ error: "empty_message" });
    }
    const ts = Date.now();
    try {
      const result = await run(
        "INSERT INTO chat_messages (channel_uuid, channel, user, text, ts) VALUES (?, ?, ?, ?, ?)",
        [channelRow.channel_uuid, channelName, username, text, ts]
      );
      const messageId = result.lastID;
      const attachments = [];
      for (const f of files) {
        const storedName = path.basename(f.filename);
        const originalName = f.originalname || f.filename;
        const mime = f.mimetype || "application/octet-stream";
        const size = f.size || 0;
        const insert = await run(
          `INSERT INTO chat_attachments
           (message_id, stored_name, original_name, mime, size, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [messageId, storedName, originalName, mime, size, ts]
        );
        attachments.push({
          id: insert.lastID,
          url: "/api/chat/uploads/" + encodeURIComponent(storedName),
          downloadUrl: "/api/chat/attachments/" + insert.lastID + "/download",
          name: originalName,
          mime,
          size,
          isImage: mime.startsWith("image/"),
          isVideo: mime.startsWith("video/")
        });
      }
      return res.json({
        message: {
          id: messageId,
          user: username,
          text,
          ts,
          deleted: 0,
          channel: channelName,
          channelId: channelRow.channel_uuid,
          attachments
        }
      });
    } catch (err) {
      console.error("chat send error", err);
      return res.status(500).json({ error: "server_error" });
    }
  });

  router.get("/attachments/:id/download", requireAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: "bad_request" });
    try {
      const row = await get(
        "SELECT stored_name, original_name FROM chat_attachments WHERE id=?",
        [id]
      );
      if (!row) return res.status(404).json({ error: "not_found" });
      const filePath = path.join(uploadDir, row.stored_name);
      return res.download(filePath, row.original_name);
    } catch (err) {
      console.error("chat download error", err);
      return res.status(500).json({ error: "server_error" });
    }
  });

  router.use("/uploads", requireAuth, (req, res, next) => {
    if (req.method !== "GET") return res.status(405).send("method_not_allowed");
    next();
  });
  router.use("/uploads", expressStatic(uploadDir));

  return router;
}

function expressStatic(dir) {
  return function (req, res, next) {
    const filePath = path.join(dir, decodeURIComponent(req.path || ""));
    if (!filePath.startsWith(dir)) return res.status(403).send("forbidden");
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return next();
      res.sendFile(filePath);
    });
  };
}

export function attachChatWs(server, { projectRoot }) {
  const wss = new WebSocketServer({ server, path: "/chat-ws" });

  function broadcastPresence() {
    const users = new Set();
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN && client.username) {
        users.add(client.username);
      }
    });
    const payload = JSON.stringify({ type: "presence_snapshot", users: [...users] });
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(payload);
    });
  }

  function broadcastToChannel(channel, payload) {
    const data = JSON.stringify(payload);
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN && client.channelId === channel) {
        client.send(data);
      }
    });
  }

  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token");
    const channelParam = url.searchParams.get("channel") || "general";

    let decoded;
    try {
      decoded = verifyToken(token || "");
    } catch {
      ws.close(4001, "Invalid session");
      return;
    }
    const username = decoded?.username;
    if (!username) {
      ws.close(4001, "Invalid session");
      return;
    }

    const roomRows = await loadRooms();
    const channelId = normalizeChannel(channelParam, roomRows);
    let channelRow = null;
    let channelName = "";
    if (isDmChannel(channelId)) {
      const dmChannel = await ensureDmChannel(channelId, username);
      if (!dmChannel) {
        ws.close(4002, "Not allowed");
        return;
      }
      channelRow = dmChannel;
      channelName = dmChannel.name;
    } else {
      channelRow = roomRows.find((room) => room.channel_uuid === channelId)
        || await getChannelById(channelId)
        || await getChannelByName(channelId, false)
        || roomRows[0];
      if (!channelRow) {
        ws.close(4002, "Not allowed");
        return;
      }
      channelName = channelRow.name;
      await ensureChannelMember(channelRow.channel_uuid, username, Date.now());
    }

    ws.username = username;
    ws.channelId = channelRow.channel_uuid;
    ws.channelName = channelName;
    broadcastPresence();

    ws.on("message", async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (data.type === "typing") {
        broadcastToChannel(ws.channelId, { type: "typing", user: ws.username });
        return;
      }
      if (data.type !== "chat") return;
      const text = String(data.text || "").trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) return;
      const ts = Date.now();
      try {
        const result = await run(
          "INSERT INTO chat_messages (channel_uuid, channel, user, text, ts) VALUES (?, ?, ?, ?, ?)",
          [ws.channelId, ws.channelName, ws.username, text, ts]
        );
        const message = {
          type: "chat",
          id: result.lastID,
          user: ws.username,
          text,
          ts,
          deleted: 0,
          channel: ws.channelName,
          channelId: ws.channelId,
          attachments: []
        };
        broadcastToChannel(ws.channelId, message);
      } catch (err) {
        console.error("chat ws message error", err);
      }
    });

    ws.on("close", () => {
      broadcastPresence();
    });
  });

  return wss;
}
