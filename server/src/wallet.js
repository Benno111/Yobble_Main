import { get, run } from "./db.js";

export async function ensureWallet(user_id){
  const w = await get("SELECT user_id FROM wallets WHERE user_id=?", [user_id]);
  if(!w){
    await run("INSERT INTO wallets(user_id,balance,updated_at) VALUES(?,?,?)", [user_id, 0, Date.now()]);
  }
}

export async function getBalance(user_id){
  await ensureWallet(user_id);
  const w = await get("SELECT balance FROM wallets WHERE user_id=?", [user_id]);
  return w?.balance ?? 0;
}

export async function changeBalance(user_id, delta, reason, ref_type=null, ref_id=null){
  await ensureWallet(user_id);
  const now = Date.now();
  await run("UPDATE wallets SET balance=balance+?, updated_at=? WHERE user_id=?", [delta, now, user_id]);
  await run(
    `INSERT INTO wallet_transactions(user_id,amount,reason,ref_type,ref_id,created_at)
     VALUES(?,?,?,?,?,?)`,
    [user_id, delta, reason, ref_type, ref_id, now]
  );
}
