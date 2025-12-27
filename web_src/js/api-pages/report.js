import { api } from "../api.js";
export { api };
export function fmtError(err){
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  if (err.error) return err.error;
  return "request failed";
}
