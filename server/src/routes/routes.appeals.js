import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { get, all, run } from "../db.js";

export const appealsRouter = express.Router();

appealsRouter.post("/create", requireAuth, async (req,res)=>{
  const ban_id = Number(req.body?.ban_id);
  const message = String(req.body?.message||"").trim();
  if(!Number.isFinite(ban_id)||!message)
    return res.status(400).json({error:"missing_fields"});

  const ban = await get(
    `SELECT id,target_type,target_id FROM bans WHERE id=? AND lifted_at IS NULL`,
    [ban_id]
  );
  if(!ban) return res.status(404).json({error:"ban_not_found"});
  if(ban.target_type!=="user"||ban.target_id!==req.user.uid)
    return res.status(403).json({error:"not_your_ban"});

  const open = await get(
    `SELECT id FROM ban_appeals WHERE ban_id=? AND status='open'`,
    [ban_id]
  );
  if(open) return res.status(400).json({error:"appeal_already_open"});

  await run(
    `INSERT INTO ban_appeals(ban_id,user_id,status,message,created_at)
     VALUES(?,?,?,?,?)`,
    [ban_id, req.user.uid, "open", message, Date.now()]
  );
  res.json({ok:true});
});

appealsRouter.get("/mod/open", requireAuth, requireRole("moderator"), async (_req,res)=>{
  const rows = await all(`
    SELECT a.id,a.ban_id,a.message,a.created_at,
           b.reason,b.expires_at,b.target_type,b.target_id,
           u.username
    FROM ban_appeals a
    JOIN bans b ON b.id=a.ban_id
    JOIN users u ON u.id=a.user_id
    WHERE a.status='open'
    ORDER BY a.created_at
  `);
  res.json({appeals:rows});
});

appealsRouter.post("/mod/decide", requireAuth, requireRole("moderator"), async (req,res)=>{
  const id = Number(req.body?.id);
  const decision = String(req.body?.decision||"");
  const note = String(req.body?.note||"");
  if(!Number.isFinite(id)||!["accepted","rejected"].includes(decision))
    return res.status(400).json({error:"bad_request"});

  await run(
    `UPDATE ban_appeals
     SET status=?,decided_by=?,decided_at=?,decision_note=?
     WHERE id=? AND status='open'`,
    [decision, req.user.uid, Date.now(), note, id]
  );

  if(decision==="accepted"){
    const row = await get(`SELECT ban_id FROM ban_appeals WHERE id=?`, [id]);
    if(row){
      await run(
        `UPDATE bans SET lifted_at=?, lift_reason=? WHERE id=?`,
        [Date.now(), "Appeal accepted: "+note, row.ban_id]
      );
    }
  }
  res.json({ok:true});
});
