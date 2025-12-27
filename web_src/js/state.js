import { api } from "./api.js";
let cachedMe = null;
export async function getMe(){
  if(cachedMe) return cachedMe;
  // Try real API if present
  try{
    const r = await api("/api/profile/me");
    cachedMe = r?.profile || null;
    return cachedMe;
  }catch{
    // Fallback to localStorage (works with minimal server zip)
    const username = localStorage.getItem("username") || "player";
    const role = localStorage.getItem("role") || "user";
    cachedMe = { username, role };
    return cachedMe;
  }
}
export function clearMe(){
  cachedMe = null;
}
