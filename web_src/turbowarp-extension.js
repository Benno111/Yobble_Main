(function(Scratch){
  "use strict";

  const API_BASE = "__API_BASE__";
  const API_BASE_STORAGE_KEY = "yobbleApiBase";

  function resolveApiBase(){
    const base = (API_BASE && API_BASE !== "__API_BASE__") ? API_BASE : "";
    const stored = (window.localStorage && window.localStorage.getItem(API_BASE_STORAGE_KEY)) || "";
    const fallback = "https://photography-cage.gl.at.ply.gg:52426";
    const raw = base || stored || fallback;
    return raw.replace(/\/+$/, "");
  }

  function buildAuthHeaders(){
    try{
      const token = window.localStorage && window.localStorage.getItem("token");
      if (token) return { Authorization: "Bearer " + token };
    }catch{}
    return {};
  }

  async function getJson(path){
    const base = resolveApiBase();
    if (!base) throw new Error("missing_api_base");
    const res = await fetch(base + path, {
      mode: "cors",
      headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
      credentials: "omit"
    });
    if (!res.ok) throw new Error("request_failed");
    return await res.json();
  }

  async function postJson(path, body, method){
    const base = resolveApiBase();
    if (!base) throw new Error("missing_api_base");
    const res = await fetch(base + path, {
      method: method || "POST",
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
          },
          {
            opcode: "accountLogin",
            blockType: Scratch.BlockType.REPORTER,
            text: "login username [USER] password [PASS] otp [OTP] (json)",
            arguments: {
              USER: { type: Scratch.ArgumentType.STRING, defaultValue: "user" },
              PASS: { type: Scratch.ArgumentType.STRING, defaultValue: "password" },
              OTP: { type: Scratch.ArgumentType.STRING, defaultValue: "" }
            }
          },
          {
            opcode: "setApiBase",
            blockType: Scratch.BlockType.COMMAND,
            text: "set api base [BASE]",
            arguments: {
              BASE: { type: Scratch.ArgumentType.STRING, defaultValue: "http://localhost:5050" }
            }
          },
          {
            opcode: "customLevelsList",
            blockType: Scratch.BlockType.REPORTER,
            text: "custom levels list for game [project] (json)",
            arguments: {
              project: { type: Scratch.ArgumentType.STRING, defaultValue: "game-project" }
            }
          },
          {
            opcode: "customLevelsSearch",
            blockType: Scratch.BlockType.REPORTER,
            text: "custom levels search game [project] query [Q] creator [CREATOR] difficulty [DIFF] (json)",
            arguments: {
              project: { type: Scratch.ArgumentType.STRING, defaultValue: "game-project" },
              Q: { type: Scratch.ArgumentType.STRING, defaultValue: "" },
              CREATOR: { type: Scratch.ArgumentType.STRING, defaultValue: "" },
              DIFF: { type: Scratch.ArgumentType.STRING, defaultValue: "" }
            }
          },
          {
            opcode: "customLevelDownload",
            blockType: Scratch.BlockType.REPORTER,
            text: "custom level download game [project] id [ID] (json)",
            arguments: {
              project: { type: Scratch.ArgumentType.STRING, defaultValue: "game-project" },
              ID: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          {
            opcode: "customLevelDelete",
            blockType: Scratch.BlockType.COMMAND,
            text: "custom level delete game [project] id [ID]",
            arguments: {
              project: { type: Scratch.ArgumentType.STRING, defaultValue: "game-project" },
              ID: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 }
            }
          },
          {
            opcode: "customLevelSetDifficulty",
            blockType: Scratch.BlockType.COMMAND,
            text: "custom level set difficulty game [project] id [ID] diff [DIFF]",
            arguments: {
              project: { type: Scratch.ArgumentType.STRING, defaultValue: "game-project" },
              ID: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1 },
              DIFF: { type: Scratch.ArgumentType.NUMBER, defaultValue: 5 }
            }
          },
          {
            opcode: "customLevelUpload",
            blockType: Scratch.BlockType.COMMAND,
            text: "upload custom level game [project] title [TITLE] version [VERSION] description [DESC] data [DATA]",
            arguments: {
              project: { type: Scratch.ArgumentType.STRING, defaultValue: "game-project" },
              TITLE: { type: Scratch.ArgumentType.STRING, defaultValue: "My Level" },
              VERSION: { type: Scratch.ArgumentType.STRING, defaultValue: "1.0" },
              DESC: { type: Scratch.ArgumentType.STRING, defaultValue: "" },
              DATA: { type: Scratch.ArgumentType.STRING, defaultValue: "{}" }
            }
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

    async accountLogin(args){
      const username = String(args.USER || "").trim();
      const password = String(args.PASS || "");
      const otp = String(args.OTP || "").trim();
      if (!username || !password) return JSON.stringify({ error: "missing_fields" });
      const payload = { username, password };
      if (otp) payload.totp = otp;
      const data = await postJson("/api/auth/login", payload);
      try {
        if (data?.token) {
          window.localStorage.setItem("token", data.token);
          window.localStorage.setItem("username", data?.user?.username || username);
        }
      } catch {}
      return JSON.stringify(data || {});
    }

    async setApiBase(args){
      const base = String(args.BASE || "").trim();
      try {
        if (base) {
          window.localStorage.setItem(API_BASE_STORAGE_KEY, base);
        }
      } catch {}
    }

    async customLevelsList(args){
      const project = String(args.project || "").trim();
      if (!project) return JSON.stringify({ error: "missing_project" });
      const data = await getJson("/api/games/custom-lvl/" + encodeURIComponent(project) + "/list");
      return JSON.stringify(data || {});
    }

    async customLevelsSearch(args){
      const project = String(args.project || "").trim();
      if (!project) return JSON.stringify({ error: "missing_project" });
      const params = new URLSearchParams();
      const q = String(args.Q || "").trim();
      const creator = String(args.CREATOR || "").trim();
      const diff = String(args.DIFF || "").trim();
      if (q) params.set("q", q);
      if (creator) params.set("creator", creator);
      if (diff) params.set("difficulty", diff);
      const query = params.toString();
      const path = "/api/games/custom-lvl/" + encodeURIComponent(project) + "/search" + (query ? "?" + query : "");
      const data = await getJson(path);
      return JSON.stringify(data || {});
    }

    async customLevelDownload(args){
      const project = String(args.project || "").trim();
      const id = Number(args.ID);
      if (!project || !Number.isFinite(id)) return JSON.stringify({ error: "missing_fields" });
      const data = await getJson("/api/games/custom-lvl/" + encodeURIComponent(project) + "/download/" + id);
      return JSON.stringify(data || {});
    }

    async customLevelDelete(args){
      const project = String(args.project || "").trim();
      const id = Number(args.ID);
      if (!project || !Number.isFinite(id)) return;
      await postJson(
        "/api/games/custom-lvl/" + encodeURIComponent(project) + "/delete/" + id,
        {},
        "DELETE"
      );
    }

    async customLevelSetDifficulty(args){
      const project = String(args.project || "").trim();
      const id = Number(args.ID);
      const diff = Number(args.DIFF);
      if (!project || !Number.isFinite(id) || !Number.isFinite(diff)) return;
      await postJson("/api/games/custom-lvl/" + encodeURIComponent(project) + "/difficulty/" + id, { difficulty: diff });
    }

    async customLevelUpload(args){
      const project = String(args.project || "").trim();
      const title = String(args.TITLE || "").trim();
      const version = String(args.VERSION || "").trim();
      const description = String(args.DESC || "").trim();
      const raw_data = String(args.DATA || "");
      if (!project || !title || !version || !raw_data) {
        return;
      }
      await postJson("/api/games/custom-lvl/" + encodeURIComponent(project) + "/upload", {
        title,
        version,
        description,
        raw_data
      });
    }
  }

  Scratch.extensions.register(new YobbleExtension());
})(Scratch);
