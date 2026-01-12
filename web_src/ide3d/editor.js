const api = async (path, options = {}) => {
  const init = {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  };
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.error ? ` (${data.error})` : "";
    } catch {
      // ignore
    }
    throw new Error(`Request failed: ${res.status}${detail}`);
  }
  return res.json();
};

const state = {
  projectId: null,
  projectName: "",
  data: null,
  saving: false
};

const els = {
  projectName: document.querySelector("#projectName"),
  consoleLog: document.querySelector("#consoleLog"),
  playBtn: document.querySelector("#btnPlay"),
  buildBtn: document.querySelector("#btnBuild"),
  bakeBtn: document.querySelector("#btnBake"),
  purgeBtn: document.querySelector("#btnPurge"),
  quickPlay: document.querySelector("#quickPlay")
};

const appendLog = (tag, message) => {
  if (!els.consoleLog) return;
  const entry = document.createElement("div");
  entry.innerHTML = `<span>[${tag}]</span> ${message}`;
  els.consoleLog.appendChild(entry);
  els.consoleLog.scrollTop = els.consoleLog.scrollHeight;
};

const scheduleSave = (() => {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => saveProject(), 900);
  };
})();

const loadProject = async (id) => {
  const payload = await api(`/api/gameeditor/projects/${id}`);
  state.projectId = payload.project.id;
  state.projectName = payload.project.name;
  try {
    state.data = JSON.parse(payload.project.data);
  } catch {
    state.data = payload.project.data;
  }
  if (state.data?.meta) state.data.meta.title = state.projectName;
  if (els.projectName) els.projectName.value = state.projectName;
  localStorage.setItem("ide3d:lastProjectId", String(state.projectId));
  appendLog("Project", `Loaded ${state.projectName}`);
};

const createProject = async (format) => {
  const payload = await api("/api/gameeditor/projects", {
    method: "POST",
    body: JSON.stringify({
      name: "Yobble 3D Project",
      data: format
    })
  });
  state.projectId = payload.project.id;
  state.projectName = payload.project.name;
  state.data = JSON.parse(payload.project.data);
  if (els.projectName) els.projectName.value = state.projectName;
  localStorage.setItem("ide3d:lastProjectId", String(state.projectId));
  appendLog("Project", `Created ${state.projectName}`);
};

const saveProject = async () => {
  if (!state.projectId || !state.data || state.saving) return;
  state.saving = true;
  try {
    if (state.data?.meta) state.data.meta.title = state.projectName;
    await api(`/api/gameeditor/projects/${state.projectId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: state.projectName,
        data: state.data
      })
    });
    appendLog("Save", "Project synced to server");
  } catch (err) {
    appendLog("Error", err.message);
  } finally {
    state.saving = false;
  }
};

const boot = async () => {
  try {
    const format = await api("/api/gameeditor/format");
    const list = await api("/api/gameeditor/projects");
    const lastId = Number(localStorage.getItem("ide3d:lastProjectId"));
    const available = list.projects || [];

    if (available.length) {
      const match = available.find((p) => p.id === lastId) || available[0];
      await loadProject(match.id);
    } else {
      await createProject(format.format);
    }
  } catch (err) {
    appendLog("Error", err.message);
  }
};

if (els.projectName) {
  els.projectName.addEventListener("input", (event) => {
    state.projectName = event.target.value.trim() || "Untitled Project";
    scheduleSave();
  });
}

if (els.buildBtn) {
  els.buildBtn.addEventListener("click", () => {
    appendLog("Build", "Queued build for web export");
    saveProject();
  });
}

if (els.bakeBtn) {
  els.bakeBtn.addEventListener("click", () => {
    appendLog("Bake", "Lighting bake started");
  });
}

if (els.purgeBtn) {
  els.purgeBtn.addEventListener("click", () => {
    appendLog("Cache", "Editor cache cleared");
  });
}

const togglePlay = () => {
  appendLog("Play", "Simulation toggled");
};

if (els.playBtn) els.playBtn.addEventListener("click", togglePlay);
if (els.quickPlay) els.quickPlay.addEventListener("click", togglePlay);

const initRenderer = () => {
  const canvas = document.getElementById("viewportCanvas");
  if (!canvas) return;
  const gl = canvas.getContext("webgl", { antialias: true });
  if (!gl) {
    appendLog("Render", "WebGL not supported");
    return;
  }

  const vertSrc = `
    attribute vec3 aPos;
    attribute vec3 aColor;
    uniform mat4 uMvp;
    varying vec3 vColor;
    void main() {
      vColor = aColor;
      gl_Position = uMvp * vec4(aPos, 1.0);
    }
  `;
  const fragSrc = `
    precision mediump float;
    varying vec3 vColor;
    void main() {
      gl_FragColor = vec4(vColor, 1.0);
    }
  `;

  const compile = (type, src) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      appendLog("Render", gl.getShaderInfoLog(shader) || "Shader error");
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vs = compile(gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return;
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    appendLog("Render", gl.getProgramInfoLog(program) || "Link error");
    return;
  }
  gl.useProgram(program);

  const positions = new Float32Array([
    -1, -1, -1,  1, -1, -1,  1,  1, -1,
    -1, -1, -1,  1,  1, -1, -1,  1, -1,
    -1, -1,  1,  1, -1,  1,  1,  1,  1,
    -1, -1,  1,  1,  1,  1, -1,  1,  1,
    -1, -1, -1, -1,  1, -1, -1,  1,  1,
    -1, -1, -1, -1,  1,  1, -1, -1,  1,
     1, -1, -1,  1,  1, -1,  1,  1,  1,
     1, -1, -1,  1,  1,  1,  1, -1,  1,
    -1, -1, -1, -1, -1,  1,  1, -1,  1,
    -1, -1, -1,  1, -1,  1,  1, -1, -1,
    -1,  1, -1, -1,  1,  1,  1,  1,  1,
    -1,  1, -1,  1,  1,  1,  1,  1, -1
  ]);
  const colors = new Float32Array([
    0.22, 0.74, 0.97,  0.22, 0.74, 0.97,  0.22, 0.74, 0.97,
    0.22, 0.74, 0.97,  0.22, 0.74, 0.97,  0.22, 0.74, 0.97,
    0.98, 0.45, 0.11,  0.98, 0.45, 0.11,  0.98, 0.45, 0.11,
    0.98, 0.45, 0.11,  0.98, 0.45, 0.11,  0.98, 0.45, 0.11,
    0.13, 0.78, 0.37,  0.13, 0.78, 0.37,  0.13, 0.78, 0.37,
    0.13, 0.78, 0.37,  0.13, 0.78, 0.37,  0.13, 0.78, 0.37,
    0.93, 0.85, 0.29,  0.93, 0.85, 0.29,  0.93, 0.85, 0.29,
    0.93, 0.85, 0.29,  0.93, 0.85, 0.29,  0.93, 0.85, 0.29,
    0.64, 0.38, 0.96,  0.64, 0.38, 0.96,  0.64, 0.38, 0.96,
    0.64, 0.38, 0.96,  0.64, 0.38, 0.96,  0.64, 0.38, 0.96,
    0.94, 0.37, 0.53,  0.94, 0.37, 0.53,  0.94, 0.37, 0.53,
    0.94, 0.37, 0.53,  0.94, 0.37, 0.53,  0.94, 0.37, 0.53
  ]);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

  const colBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  const aColor = gl.getAttribLocation(program, "aColor");
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);

  const uMvp = gl.getUniformLocation(program, "uMvp");

  const mat4 = {
    identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    multiply: (a, b) => {
      const o = new Array(16).fill(0);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          o[r * 4 + c] =
            a[r * 4 + 0] * b[0 * 4 + c] +
            a[r * 4 + 1] * b[1 * 4 + c] +
            a[r * 4 + 2] * b[2 * 4 + c] +
            a[r * 4 + 3] * b[3 * 4 + c];
        }
      }
      return o;
    },
    perspective: (fov, aspect, near, far) => {
      const f = 1 / Math.tan(fov / 2);
      return [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0
      ];
    },
    translate: (m, v) => {
      const [x, y, z] = v;
      const t = mat4.identity();
      t[12] = x;
      t[13] = y;
      t[14] = z;
      return mat4.multiply(m, t);
    },
    rotateY: (m, rad) => {
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const r = [
        c, 0, s, 0,
        0, 1, 0, 0,
        -s, 0, c, 0,
        0, 0, 0, 1
      ];
      return mat4.multiply(m, r);
    },
    rotateX: (m, rad) => {
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const r = [
        1, 0, 0, 0,
        0, c, -s, 0,
        0, s, c, 0,
        0, 0, 0, 1
      ];
      return mat4.multiply(m, r);
    }
  };

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  resize();
  window.addEventListener("resize", resize);

  const render = (t) => {
    const time = t * 0.001;
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.05, 0.07, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = canvas.width / canvas.height;
    let mvp = mat4.perspective(1.1, aspect, 0.1, 100);
    let model = mat4.identity();
    model = mat4.translate(model, [0, 0, -4]);
    model = mat4.rotateY(model, time * 0.6);
    model = mat4.rotateX(model, time * 0.4);
    mvp = mat4.multiply(mvp, model);

    gl.uniformMatrix4fv(uMvp, false, new Float32Array(mvp));
    gl.drawArrays(gl.TRIANGLES, 0, positions.length / 3);
    requestAnimationFrame(render);
  };
  requestAnimationFrame(render);
};

boot();
initRenderer();
