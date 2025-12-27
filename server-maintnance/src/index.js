import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(PROJECT_ROOT);

const app = express();
app.use((_req, res) => {
  res.status(503).sendFile(path.join(WEB_DIR, "index.html"));
});

const PORT = Number(process.env.PORT || 5050);
app.listen(PORT, () => {
  console.log(`Maintenance server running at http://localhost:${PORT}`);
});
const PORT2 = Number(process.env.PORT2 || 3000);
app.listen(PORT2, () => {
  console.log(`Maintenance server running at http://localhost:${PORT2}`);
});
