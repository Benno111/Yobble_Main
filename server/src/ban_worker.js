import { run } from "./db.js";

export function startBanWorker(){
  const tick = async ()=>{
    const now = Date.now();
    await run(
      `UPDATE bans
       SET lifted_at=?, lift_reason='Auto-expired'
       WHERE lifted_at IS NULL
         AND expires_at IS NOT NULL
         AND expires_at <= ?`,
      [now, now]
    );
  };
  tick().catch(()=>{});
  setInterval(()=> tick().catch(()=>{}), 60000);
}
