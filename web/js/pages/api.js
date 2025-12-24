export const api = {
  get(url){ return request(url); },
  post(url, body){ return request(url, { method:"POST", body: JSON.stringify(body) }); }
};

async function request(url, opts={}){
  const token = localStorage.getItem("token");
  const r = await fetch(url, {
    ...opts,
    headers:{
      "Content-Type":"application/json",
      ...(token ? { Authorization:`Bearer ${token}` } : {})
    }
  });

  if(r.status === 401){
    localStorage.removeItem("token");
    location.href = "/login.html";
    throw new Error("unauthorized");
  }
  if(r.status === 403){
    location.href = "/login.html";
    throw new Error("forbidden");
  }
  if(!r.ok){
    let e;
    try{ e = await r.json(); }catch{}
    throw e || new Error(r.statusText);
  }
  return r.json();
}
