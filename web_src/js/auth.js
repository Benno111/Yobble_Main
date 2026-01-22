import { api } from "./api.js";
export async function requireAuth(){
  const token = localStorage.getItem("token");
  if(!token){
    location.href = "/login";
    throw new Error("no token");
  }
  try{
    const res = await api.get("/api/auth/me");
    const user = res.user || res;
    window.PLATFORM_USER = user;
    return user;
  }catch(err){
    if (err?.status === 403 && err?.data?.error === "account_banned") {
      location.href = "/Permanetly-Banned";
      throw err;
    }
    if (err?.status === 403 && err?.data?.error === "account_timed_out") {
      const until = err?.data?.until ? `?until=${encodeURIComponent(err.data.until)}` : "";
      location.href = `/temporay-banned${until}`;
      throw err;
    }
    throw err;
  }
}
export async function requireAuthAllowBanned(){
  const token = localStorage.getItem("token");
  if(!token){
    location.href = "/login";
    throw new Error("no token");
  }
  try{
    const res = await api.get("/api/auth/me-allow-banned");
    const user = res.user || res;
    window.PLATFORM_USER = user;
    return user;
  }catch(err){
    throw err;
  }
}
export async function logout(){
  try{
    await api.post("/api/auth/logout", {});
  }catch{}
  localStorage.removeItem("token");
  location.href = "/login";
}
