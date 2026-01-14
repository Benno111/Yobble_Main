import express from "express";
import { all, get, run } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export const moderationRouter = express.Router();

moderationRouter.get("/games/pending", requireAuth, requireRole("moderator"), async (_req,res)=>{
  const rows = await all(
    `SELECT g.project, g.title, v.version, v.entry_html, v.created_at, v.approval_status,
            u.username AS uploader
     FROM game_versions v
     JOIN games g ON g.id=v.game_id
     LEFT JOIN game_uploads gu ON gu.game_id=g.id AND gu.version=v.version
     LEFT JOIN users u ON u.id=gu.uploader_user_id
     WHERE v.approval_status='pending'
     ORDER BY v.created_at ASC`
  );
  res.json({ pending: rows });
});

moderationRouter.post("/games/approve", requireAuth, requireRole("moderator"), async (req,res)=>{
  const project = String(req.body?.project||"").trim();
  const version = String(req.body?.version||"").trim();
  const publish = !!req.body?.publish;
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  await run(
    `UPDATE game_versions
     SET approval_status='approved', approved_by=?, approved_at=?, rejected_reason=NULL
     WHERE game_id=? AND version=?`,
    [req.user.uid, Date.now(), g.id, version]
  );

  if(publish){
    await run("UPDATE game_versions SET is_published=0 WHERE game_id=?", [g.id]);
    await run("UPDATE game_versions SET is_published=1 WHERE game_id=? AND version=?", [g.id, version]);
  }

  res.json({ ok:true });
});

moderationRouter.post("/games/reject", requireAuth, requireRole("moderator"), async (req,res)=>{
  const project = String(req.body?.project||"").trim();
  const version = String(req.body?.version||"").trim();
  const reason = String(req.body?.reason||"").slice(0,500);
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  await run(
    `UPDATE game_versions
     SET approval_status='rejected', rejected_reason=?, approved_by=NULL, approved_at=NULL, is_published=0
     WHERE game_id=? AND version=?`,
    [reason || null, g.id, version]
  );

  res.json({ ok:true });
});
