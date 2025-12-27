// Compatibility shim for older pages that used window.api()
import { api } from "/js/api-pages/app.js";
window.api = async (path, method="GET", body=null)=>{
  return api(path, { method, body });
};
