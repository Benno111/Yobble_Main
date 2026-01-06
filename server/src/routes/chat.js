import fs from "fs";
import path from "path";
import express from "express";
import { WebSocketServer } from "ws";
import multer from "multer";
import { all, get, run } from "../db.js";
import { requireAuth, verifyToken } from "../auth.js";

const DEFAULT_ROOMS = ["general", "rules", "announcements", "offtopic"];
const MAX_MESSAGE_LENGTH = 2000;
const MAX_ATTACHMENTS = 5;

function sanitizeRoom(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return "";
  if (!/^[a-z0-9_-]+$/.test(trimmed)) return "";
  return trimmed;
}

function loadRooms(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const data = JSON.parse(raw);
    const rooms = Array.isArray(data?.rooms) ? data.rooms : [];
    const cleaned = rooms
      .map(sanitizeRoom)
      .filter(Boolean);
    return cleaned.length ? cleaned : DEFAULT_ROOMS.slice();
  } catch {
    return DEFAULT_ROOMS.slice();
  }
}

function isDmChannel(channel) {
  return channel.startsWith("dm:");
}

function dmParticipants(channel) {
  return channel.slice(3).split(",");
}

function userAllowedForChannel(username, channel, rooms) {
  if (isDmChannel(channel)) {
    const people = dmParticipants(channel);
    return people.includes(username);
  }
  return rooms.includes(channel);
}

function normalizeChannel(input, rooms) {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) return rooms[0] || "general";
  if (isDmChannel(trimmed)) return trimmed;
  const cleaned = sanitizeRoom(trimmed);
  return cleaned && rooms.includes(cleaned) ? cleaned : rooms[0] || "general";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function createChatRouter({ projectRoot }) {
  const router = express.Router();

  const uploadDir = path.join(projectRoot, "server", "uploads", "chat");
  const roomsConfigPath = path.join(projectRoot, "server", "chat_rooms.json");
  ensureDir(uploadDir);

  const upload = multer({ dest: uploadDir });

  router.get("/rooms", requireAuth, (req, res) => {
    res.json({ rooms: loadRooms(roomsConfigPath) });
  });

  router.get("/messages", requireAuth, async (req, res) => {
    const { username } = req.user;
    const rooms = loadRooms(roomsConfigPath);
    const channel = normalizeChannel(req.query.channel, rooms);
    if (!userAllowedForChannel(username, channel, rooms)) {
      return res.status(403).json({ error: "not_allowed" });
    }
    const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : null;
    const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);

    let sql = `
      SELECT id, user, text, ts, deleted, channel
      FROM chat_messages
      WHERE channel = ? AND deleted = 0
    `;
    const params = [channel];
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
    const rooms = loadRooms(roomsConfigPath);
    const channel = normalizeChannel(req.body?.channel, rooms);
    if (!userAllowedForChannel(username, channel, rooms)) {
      return res.status(403).json({ error: "not_allowed" });
    }
    const text = String(req.body?.text || "").trim().slice(0, MAX_MESSAGE_LENGTH);
    const files = Array.isArray(req.files) ? req.files : [];
    if (!text && !files.length) {
      return res.status(400).json({ error: "empty_message" });
    }
    const ts = Date.now();
    try {
      const result = await run(
        "INSERT INTO chat_messages (channel, user, text, ts) VALUES (?, ?, ?, ?)",
        [channel, username, text, ts]
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
          channel,
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
  const roomsConfigPath = path.join(projectRoot, "server", "chat_rooms.json");
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
      if (client.readyState === client.OPEN && client.channel === channel) {
        client.send(data);
      }
    });
  }

  wss.on("connection", (ws, req) => {
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

    const rooms = loadRooms(roomsConfigPath);
    const channel = normalizeChannel(channelParam, rooms);
    if (!userAllowedForChannel(username, channel, rooms)) {
      ws.close(4002, "Not allowed");
      return;
    }

    ws.username = username;
    ws.channel = channel;
    broadcastPresence();

    ws.on("message", async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (data.type === "typing") {
        broadcastToChannel(ws.channel, { type: "typing", user: ws.username });
        return;
      }
      if (data.type !== "chat") return;
      const text = String(data.text || "").trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) return;
      const ts = Date.now();
      try {
        const result = await run(
          "INSERT INTO chat_messages (channel, user, text, ts) VALUES (?, ?, ?, ?)",
          [ws.channel, ws.username, text, ts]
        );
        const message = {
          type: "chat",
          id: result.lastID,
          user: ws.username,
          text,
          ts,
          deleted: 0,
          channel: ws.channel,
          attachments: []
        };
        broadcastToChannel(ws.channel, message);
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
