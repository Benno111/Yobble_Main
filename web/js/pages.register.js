import { register } from "./auth.js";

const username = document.querySelector("#username");
const email = document.querySelector("#email");
const password = document.querySelector("#password");
const admin_code = document.querySelector("#admin_code");
const msg = document.querySelector("#msg");

document.querySelector("#go").addEventListener("click", async ()=>{
  msg.textContent = "";
  try{
    await register(username.value.trim(), email.value.trim(), password.value, admin_code.value.trim());
    location.href = "/index.html";
  }catch(e){
    msg.textContent = "Register failed: " + e.message;
  }
});
