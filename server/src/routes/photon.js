import express from "express";
import { verifyToken } from "../auth.js";

export const photonRouter = express.Router();

function readAuthUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

photonRouter.get("/config", (req, res) => {
  const appId = process.env.PHOTON_APP_ID || "";
  const region = process.env.PHOTON_REGION || "us";
  const appVersion = process.env.PHOTON_APP_VERSION || "1.0";
  const sdkUrl = process.env.PHOTON_SDK_URL || "/js/vendor/photon-realtime.min.js";
  const authType = process.env.PHOTON_AUTH_TYPE || "none";
  const decoded = readAuthUser(req);

  res.json({
    enabled: !!appId,
    appId: appId || null,
    region,
    appVersion,
    sdkUrl,
    authType,
    userId: decoded?.uid || null,
    username: decoded?.username || null
  });
});
