import { api } from "../api.js";
const u = document.getElementById("u");
const p = document.getElementById("p");
const err = document.getElementById("err");
document.getElementById("btn").onclick = async ()=>{
  err.textContent = "";
  try{
    const r = await api.post("/api/auth/login", { username:u.value, password:p.value });
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
