import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth, requireRole } from "../auth.js";
import { run, all } from "../db.js";

export const reportsRouter = express.Router();

const SERVER_DIR = path.resolve(process.cwd());
const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
const TMP_DIR = path.join(PROJECT_ROOT, "save", "uploads", "report_evidence");
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }
});

async function createReport(req, res){
  const { target_type, target_ref, category, message } = req.body || {};
  if(!target_type || !["user","game","item","listing","trade"].includes(target_type)){
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
     (reporter_id,target_type,target_ref,category,message,created_at)
     VALUES(?,?,?,?,?,?)`,
    [req.user.uid, target_type, ref, cat || null, msg, Date.now()]
  );
  res.json({ ok:true, report_id: result.lastID });
}

reportsRouter.post("/", requireAuth, createReport);
reportsRouter.post("/submit", requireAuth, createReport);

reportsRouter.post("/evidence", requireAuth, upload.single("file"), async (req,res)=>{
  const report_id = Number(req.body?.report_id);
  if(!Number.isFinite(report_id) || !req.file){
    return res.status(400).json({ error:"bad_request" });
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
    ORDER BY r.created_at
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
