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
  if (data?.token) {
    localStorage.setItem("token", data.token);
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
