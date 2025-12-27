import { run } from "./db.js";

export async function notify(userId, { type, title, body = "", link = null }) {
  await run(
    `INSERT INTO notifications (user_id,type,title,body,link,created_at)
     VALUES (?,?,?,?,?,?)`,
    [userId, type, title, body, link, Date.now()]
  );
}
