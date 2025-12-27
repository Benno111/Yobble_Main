import { requireLogin } from "../auth.js";
import { mountShell, setContent } from "../nav.js";
import { api, fmtError } from "../api-pages/report.js";
requireLogin();
await mountShell("home");
setContent(`
  <div class="grid">
    <div class="card" style="grid-column: span 7">
      <div class="h1">Report abuse</div>
      <div class="muted">Submit a report to moderators. You can attach evidence after submitting.</div>
      <div class="hr"></div>
      <div class="grid">
        <div style="grid-column: span 6">
          <label class="small">Target type</label>
          <select id="target_type">
            <option value="user">User</option>
            <option value="game">Game</option>
            <option value="item">Item</option>
            <option value="listing">Marketplace listing</option>
            <option value="trade">Trade</option>
          </select>
        </div>
        <div style="grid-column: span 6">
          <label class="small">Target reference (username/slug/code)</label>
          <input id="target_ref" placeholder="e.g. benno111 or dorfplatformer-9-2">
        </div>
        <div style="grid-column: span 12">
          <label class="small">Category</label>
          <select id="category">
            <option value="harassment">Harassment</option>
            <option value="scam">Scam</option>
            <option value="cheating">Cheating</option>
            <option value="nsfw">NSFW</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div style="grid-column: span 12">
          <label class="small">Message</label>
          <textarea id="message" placeholder="Describe what happened (include dates, IDs, screenshots)."></textarea>
        </div>
        <div style="grid-column: span 12" class="row">
          <button id="submitBtn">Submit report</button>
          <span class="small" id="status"></span>
        </div>
      </div>
      <div class="hr"></div>
      <div class="h2">Evidence attachment</div>
      <div class="muted small">After you submit a report, upload files (PNG/JPG/WEBP, MP4/WEBM, PDF, TXT — up to 10MB).</div>
      <div style="height:10px"></div>
      <div class="row">
        <input id="file" type="file">
        <button class="secondary" id="uploadBtn" disabled>Upload evidence</button>
      </div>
      <div class="small muted" id="evidenceInfo"></div>
    </div>
    <div class="card" style="grid-column: span 5">
      <div class="h2">Privacy + tips</div>
      <div class="list">
        <div class="item"><b>Don’t share passwords</b><div class="small">Never include passwords or secret tokens in your report.</div></div>
        <div class="item"><b>Use clear references</b><div class="small">Username, game slug, item code, trade ID, listing ID.</div></div>
        <div class="item"><b>Attach evidence</b><div class="small">Screenshots or logs help moderators resolve faster.</div></div>
      </div>
    </div>
  </div>
`);
let lastReportId = null;
const status = document.querySelector("#status");
const submitBtn = document.querySelector("#submitBtn");
const uploadBtn = document.querySelector("#uploadBtn");
const evidenceInfo = document.querySelector("#evidenceInfo");
submitBtn.onclick = async ()=>{
  status.textContent = "";
  try{
    const r = await api("/api/reports/submit", {
      method:"POST",
      body:{
        target_type: document.querySelector("#target_type").value,
        target_ref: document.querySelector("#target_ref").value,
        category: document.querySelector("#category").value,
        message: document.querySelector("#message").value
      }
    });
    lastReportId = r.report_id || null;
    status.textContent = lastReportId ? `Report submitted (#${lastReportId}).` : "Report submitted.";
    uploadBtn.disabled = !lastReportId;
    evidenceInfo.textContent = lastReportId ? "Now you can upload evidence for this report." : "Evidence requires report_id from server.";
  }catch(e){
    status.textContent = "Failed: " + fmtError(e);
  }
};
uploadBtn.onclick = async ()=>{
  status.textContent = "";
  const f = document.querySelector("#file").files?.[0];
  if(!f){ status.textContent = "Choose a file first."; return; }
  if(!lastReportId){ status.textContent = "Submit a report first."; return; }
  const fd = new FormData();
  fd.append("report_id", String(lastReportId));
  fd.append("file", f);
  try{
    await api("/api/reports/evidence", { method:"POST", body: fd });
    status.textContent = "Evidence uploaded.";
  }catch(e){
    status.textContent = "Upload failed: " + fmtError(e);
  }
};
