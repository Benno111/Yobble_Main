#!/usr/bin/env node
import fs from "fs";
import https from "https";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.join(__dirname, "..", "package.json");

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on("error", reject);
  });
}

async function main() {
  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  const deps = pkg.dependencies || {};
  const names = Object.keys(deps);
  if (!names.length) {
    console.log("No dependencies found.");
    return;
  }

  const updates = {};
  for (const name of names) {
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    const latest = meta?.["dist-tags"]?.latest;
    if (!latest) {
      console.warn(`Skipping ${name}: no latest tag`);
      continue;
    }
    updates[name] = latest;
  }

  pkg.dependencies = { ...deps };
  for (const [name, version] of Object.entries(updates)) {
    pkg.dependencies[name] = version;
  }

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log("Updated dependencies in package.json:");
  for (const [name, version] of Object.entries(updates)) {
    console.log(`- ${name}@${version}`);
  }
  console.log("Run npm install to update the lockfile.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
