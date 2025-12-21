export async function getCurrentUser(){
  const t=localStorage.getItem("token");
  if(!t) return null;
  const r=await fetch("/api/auth/me",{headers:{Authorization:"Bearer "+t}});
  if(!r.ok) return null;
  const data = await r.json();
  return data.user || data;
}
