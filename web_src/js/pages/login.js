import { api } from "../api-pages/login.js";
const u = document.getElementById("u");
const p = document.getElementById("p");
const totpWrap = document.getElementById("totp-wrap");
const totp = document.getElementById("totp");
const err = document.getElementById("err");
document.getElementById("btn").onclick = async ()=>{
  err.textContent = "";
  try{
    const payload = { username:u.value, password:p.value };
    if (totp?.value?.trim()) payload.totp = totp.value.trim();
    const r = await api.post("/api/auth/login", payload);
    if(!r.token) throw new Error("no token");
    localStorage.setItem("token", r.token);
    if (r.user?.is_banned) {
      location.href = "/Permanetly-Banned";
    } else if (r.user?.timeout_until) {
      const until = r.user.timeout_until ? `?until=${encodeURIComponent(r.user.timeout_until)}` : "";
      location.href = `/temporay-banned${until}`;
    } else {
      location.href = "/games.html";
    }
  }catch(e){
    if (e?.status === 401 && e?.data?.error === "totp_required") {
      if (totpWrap) totpWrap.style.display = "block";
      if (totp) totp.focus();
      err.textContent = "Enter your authenticator code to continue.";
      return;
    }
    if (e?.status === 401 && e?.data?.error === "invalid_totp") {
      if (totpWrap) totpWrap.style.display = "block";
      if (totp) totp.focus();
      err.textContent = "Invalid authenticator code.";
      return;
    }
    if (e?.status === 403 && e?.data?.error === "account_banned") {
      location.href = "/Permanetly-Banned";
      return;
    }
    if (e?.status === 403 && e?.data?.error === "account_timed_out") {
      const until = e?.data?.until ? `?until=${encodeURIComponent(e.data.until)}` : "";
      location.href = `/temporay-banned${until}`;
      return;
    }
    err.textContent = typeof e === "string" ? e : JSON.stringify(e,null,2);
  }
};
