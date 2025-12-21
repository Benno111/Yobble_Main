import { api } from "../api.js";
const u = document.getElementById("u");
const p = document.getElementById("p");
const err = document.getElementById("err");
document.getElementById("btn").onclick = async ()=>{
  err.textContent = "";
  try{
    const r = await api.post("/api/auth/register", { username:u.value, password:p.value });
    if(!r.token) throw new Error("no token");
    localStorage.setItem("token", r.token);
    location.href = "/games.html";
  }catch(e){
    err.textContent = typeof e === "string" ? e : JSON.stringify(e,null,2);
  }
};
