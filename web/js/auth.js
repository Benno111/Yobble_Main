import { api } from "./api.js";

export async function requireAuth(){
  const token = localStorage.getItem("token");
  if(!token){
    location.href = "/login.html";
    throw new Error("no token");
  }
  const res = await api.get("/api/auth/me");
  const user = res.user || res;
  window.PLATFORM_USER = user;
  return user;
}

export function logout(){
  localStorage.removeItem("token");
  location.href = "/login.html";
}
