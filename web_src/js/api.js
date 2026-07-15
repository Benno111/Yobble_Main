import { clearAuthState, installAuthStorageGuards, rememberAuthState, repairAuthState } from "./auth-storage.js";
import { registerOfflinePlayServiceWorker } from "./offline-play.js";

installAuthStorageGuards();
repairAuthState();
registerOfflinePlayServiceWorker();

function sanitizeRedirectTarget(target, fallback = "/index") {
  const safeFallback = typeof fallback === "string" && fallback.startsWith("/") ? fallback : "/index";
  const raw = typeof target === "string" ? target.trim() : "";
  if (!raw) return safeFallback;
  if (/^(?:[a-z][a-z0-9+\-.]*:)?\/\//i.test(raw)) return safeFallback;

  const normalized = raw.startsWith("/") ? raw : `/${raw.replace(/^\/+/, "")}`;
  try {
    const resolved = new URL(normalized, location.origin);
    if (resolved.origin !== location.origin) return safeFallback;
    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (path === "/login" || path.startsWith("/login?") || path === "/register" || path.startsWith("/register?")) {
      return safeFallback;
    }
    return path || safeFallback;
  } catch {
    return safeFallback;
  }
}

function redirectToLogin(target = `${location.pathname}${location.search}${location.hash}`) {
  const redirect = sanitizeRedirectTarget(target, "/index");
  const href = `/login?redirect=${encodeURIComponent(redirect)}`;
  location.href = href;
  return href;
}

function buildHeaders(token, extra, body){
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(extra || {})
  };
  if (!(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}
async function readBody(res){
  const text = await res.text();
  if (!text) return null;
  try{
    return JSON.parse(text);
  }catch{
    return text;
  }
}
export async function api(url, opts = {}){
  const token = localStorage.getItem("token");
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: buildHeaders(token, opts.headers, opts.body),
    body: opts.body ? (opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body)) : undefined,
    signal: opts.signal
  });
  const data = await readBody(res);
  rememberAuthState({
    token: data?.token,
    username: data?.user?.username,
    role: data?.user?.role
  });
  if ((res.status === 401 || res.status === 403) && !new URL(url, location.origin).pathname.startsWith("/api/auth/")) {
    if (res.status === 403 && data?.error === "account_banned") {
      clearAuthState();
      location.href = "/Permanetly-Banned";
    } else if (res.status === 403 && data?.error === "account_timed_out") {
      clearAuthState();
      const until = data?.until ? `?until=${encodeURIComponent(data.until)}` : "";
      location.href = `/temporay-banned${until}`;
    } else {
      clearAuthState();
      redirectToLogin();
    }
    const err = new Error(res.status === 401 ? "unauthorized" : "forbidden");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  if (!res.ok) {
    const msg = typeof data === "string" ? data : (data?.error || res.statusText);
    const err = new Error(msg || "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
api.get = (url, opts) => api(url, { ...(opts || {}), method: "GET" });
api.post = (url, body, opts) => api(url, { ...(opts || {}), method: "POST", body });
api.put = (url, body, opts) => api(url, { ...(opts || {}), method: "PUT", body });
api.del = (url, opts) => api(url, { ...(opts || {}), method: "DELETE" });

export const API = "/api";

export function getToken(){
  return localStorage.getItem("token") || "";
}

export async function getUser(){
  const token = getToken();
  if(!token) return null;
  try{
    const data = await api.get("/api/auth/me");
    return data?.user || data || null;
  }catch{
    return null;
  }
}
