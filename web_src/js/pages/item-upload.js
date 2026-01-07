import { requireAuth } from "/js/auth.js";
/* -----------------------------
   Auth guard
------------------------------ */
let user;
try {
  user = await requireAuth();
} catch {
  document.body.innerHTML = "<h1>Not logged in</h1>";
  throw new Error("auth required");
}
/* -----------------------------
   Elements
------------------------------ */
const codeInput = document.getElementById("code");
const nameInput = document.getElementById("name");
const descInput = document.getElementById("desc");
const priceInput = document.getElementById("price");
const iconInput = document.getElementById("icon");
const uploadBtn = document.getElementById("upload");
const statusEl = document.getElementById("status");
/* -----------------------------
   Helpers
------------------------------ */
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#ff7b7b" : "";
}
function sanitizeCode(v) {
  return v.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}
/* -----------------------------
   Upload handler
------------------------------ */
uploadBtn.onclick = async () => {
  const code = sanitizeCode(codeInput.value.trim());
  const name = nameInput.value.trim();
  const description = descInput.value.trim();
  const priceRaw = priceInput ? priceInput.value : "0";
  const priceNum = Number(priceRaw);
  const price = Number.isFinite(priceNum) ? Math.floor(priceNum) : NaN;
  const icon = iconInput.files[0];
  if (!code || !name) {
    setStatus("Item code and name are required", true);
    return;
  }
  if (!Number.isFinite(price) || price < 0) {
    setStatus("Price must be 0 or higher", true);
    return;
  }
  if (icon && icon.size > 2 * 1024 * 1024) {
    setStatus("Icon file is too large (max 2MB)", true);
    return;
  }
  const form = new FormData();
  form.append("code", code);
  form.append("name", name);
  form.append("description", description);
  form.append("price", String(price));
  if (icon) form.append("icon", icon);
  uploadBtn.disabled = true;
  setStatus("Uploading…");
  try {
    const res = await fetch("/api/items/upload", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + localStorage.token
      },
      body: form
    });
    if (res.status === 401 || res.status === 403) {
      setStatus("You are not allowed to upload items", true);
      return;
    }
    const json = await res.json();
    if (!json.ok) {
      setStatus("Upload failed: " + (json.error || "unknown error"), true);
      return;
    }
    setStatus("✅ Item submitted for moderation");
    codeInput.value = "";
    nameInput.value = "";
    descInput.value = "";
    if (priceInput) priceInput.value = "";
    iconInput.value = "";
  } catch (err) {
    console.error(err);
    setStatus("Network error while uploading", true);
  } finally {
    uploadBtn.disabled = false;
  }
};
