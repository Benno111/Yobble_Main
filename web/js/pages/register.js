import { api } from "../api.js";
const u = document.getElementById("u");
const p = document.getElementById("p");
const err = document.getElementById("err");
const tosModal = document.getElementById("tosModal");
const tosCancel = document.getElementById("tosCancel");
const tosAgree = document.getElementById("tosAgree");
const tosCheck = document.getElementById("tosCheck");
let isSubmitting = false;

function openModal(){
  tosModal.classList.add("show");
  tosModal.setAttribute("aria-hidden", "false");
  tosCheck.checked = false;
  tosAgree.disabled = true;
}

function closeModal(){
  tosModal.classList.remove("show");
  tosModal.setAttribute("aria-hidden", "true");
}

async function registerAccount(){
  if (isSubmitting) return;
  isSubmitting = true;
  err.textContent = "";
  try{
    const r = await api.post("/api/auth/register", { username:u.value, password:p.value });
    if(!r.token) throw new Error("no token");
    localStorage.setItem("token", r.token);
    location.href = "/games.html";
  }catch(e){
    if (typeof e === "string") {
      err.textContent = e;
    } else if (e?.data?.error) {
      err.textContent = String(e.data.error);
    } else {
      err.textContent = e?.message || "Registration failed.";
    }
  }finally{
    isSubmitting = false;
  }
};

document.getElementById("btn").onclick = async ()=>{
  openModal();
};

tosCancel.addEventListener("click", closeModal);
tosAgree.addEventListener("click", async () => {
  closeModal();
  await registerAccount();
});
tosCheck.addEventListener("change", () => {
  tosAgree.disabled = !tosCheck.checked;
});

tosModal.addEventListener("click", (e) => {
  if (e.target === tosModal) closeModal();
});
