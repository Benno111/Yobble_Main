#!/usr/bin/env node
import sqlite3 from "sqlite3";
import path from "path";

const username = process.argv[2];

if (!username) {
  console.error("Usage: npm run make-moderator <username>");
  process.exit(1);
}

const DB_PATH = path.resolve("benno111engene.sqlite");
const db = new sqlite3.Database(DB_PATH);

db.get(
  "SELECT id, role FROM users WHERE username=?",
  [username],
  (err, row) => {
    if (err) {
      console.error("DB error:", err);
      process.exit(1);
    }

    if (!row) {
      console.error("User not found:", username);
      process.exit(1);
    }

    if (row.role === "moderator") {
      console.log(`User '${username}' is already moderator.`);
      process.exit(0);
    }

    db.run(
      "UPDATE users SET role='moderator' WHERE username=?",
      [username],
      err2 => {
        if (err2) {
          console.error("Failed to update role:", err2);
          process.exit(1);
        }

        console.log(`✅ User '${username}' promoted to moderator`);
        console.log("⚠ User must log out and log in again.");
        process.exit(0);
      }
    );
  }
);

