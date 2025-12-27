import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { all } from "../db.js";

export const modExportRouter = express.Router();

modExportRouter.get("/bans", requireAuth, requireRole("moderator"), async (_req,res)=>{
  const rows = await all(`
    SELECT target_type,target_id,reason,created_at,expires_at,lifted_at
    FROM bans ORDER BY created_at DESC
  `);

  let csv = "type,id,reason,created_at,expires_at,lifted_at\n";
  for(const r of rows){
    csv += [
      r.target_type,
      r.target_id,
      JSON.stringify(r.reason||""),
      r.created_at,
      r.expires_at||"",
      r.lifted_at||""
    ].join(",") + "\n";
  }

  res.setHeader("Content-Type","text/csv");
  res.setHeader("Content-Disposition","attachment; filename=bans.csv");
  res.send(csv);
});
