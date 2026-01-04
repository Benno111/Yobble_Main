(function(Scratch){
  "use strict";

  const API_BASE = "__API_BASE__";

  function buildAuthHeaders(){
    try{
      const token = window.localStorage && window.localStorage.getItem("token");
      if (token) return { Authorization: "Bearer " + token };
    }catch{}
    return {};
  }

  async function getJson(path){
    const res = await fetch(API_BASE + path, {
      mode: "cors",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
      credentials: "omit"
    });
    if (!res.ok) throw new Error("request_failed");
    return await res.json();
  }

  async function postJson(path, body){
    const res = await fetch(API_BASE + path, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
      credentials: "omit",
      body: JSON.stringify(body || {})
    });
    if (!res.ok) throw new Error("request_failed");
    return await res.json();
  }

  class YobbleExtension {
    getInfo(){
      return {
        id: "yobble",
        name: "Yobble",
        blocks: [
          {
            opcode: "multiplayerEnabled",
            blockType: Scratch.BlockType.BOOLEAN,
            text: "multiplayer enabled"
          },
          {
            opcode: "multiplayerConfig",
            blockType: Scratch.BlockType.REPORTER,
            text: "multiplayer config (json)"
          },
          {
            opcode: "multiplayerPing",
            blockType: Scratch.BlockType.COMMAND,
            text: "multiplayer ping"
          },
          {
            opcode: "playerStats",
            blockType: Scratch.BlockType.REPORTER,
            text: "player stats (json)"
          }
        ]
      };
    }

    async multiplayerEnabled(){
      const data = await getJson("/sdk/multiplayer");
      return !!data?.enabled;
    }

    async multiplayerConfig(){
      const data = await getJson("/sdk/multiplayer");
      return JSON.stringify(data || {});
    }

    async multiplayerPing(){
      await postJson("/sdk/multiplayer", { action: "ping" });
    }

    async playerStats(){
      const data = await getJson("/sdk/player/stats");
      return JSON.stringify(data || {});
    }
  }

  Scratch.extensions.register(new YobbleExtension());
})(Scratch);
