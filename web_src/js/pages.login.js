import { login } from "./auth.js";
const u = document.querySelector("#u");
const p = document.querySelector("#p");
const msg = document.querySelector("#msg");
document.querySelector("#go").addEventListener("click", async ()=>{
  msg.textContent = "";
  try{
    await login(u.value.trim(), p.value);
    location.href = "/index";
  }catch(e){
    msg.textContent = "Login failed: " + e.message;
  }
});
