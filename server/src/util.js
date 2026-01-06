export function nowMs(){ return Date.now(); }

export function randToken(len=48){
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

export function safeInt(v, def=0){
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
