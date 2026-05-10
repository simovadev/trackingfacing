import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  ws: document.getElementById("ws"),
  cam: document.getElementById("cam"),
  model: document.getElementById("model"),
  wake: document.getElementById("wake"),
  stats: document.getElementById("stats"),
  start: document.getElementById("start"),
  recenter: document.getElementById("recenter"),
  flip: document.getElementById("flip"),
};

const state = {
  ws: null,
  landmarker: null,
  running: false,
  center: null,
  lastSendAt: 0,
  frames: 0,
  fpsAt: performance.now(),
  facingMode: "user",
  wakeLock: null,
};

function setPill(el, text, cls) {
  el.textContent = text;
  el.className = "pill" + (cls ? " " + cls : "");
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/sender`;
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => setPill(els.ws, "ws: open", "ok"));
  ws.addEventListener("close", () => {
    setPill(els.ws, "ws: closed", "bad");
    setTimeout(connectWS, 1000);
  });
  ws.addEventListener("error", () => setPill(els.ws, "ws: error", "bad"));
  state.ws = ws;
}

async function initCamera() {
  setPill(els.cam, "cam: requesting");
  const prev = els.video.srcObject;
  if (prev) prev.getTracks().forEach((t) => t.stop());
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: state.facingMode, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
  });
  els.video.srcObject = stream;
  // Mirror only the front camera to keep movement intuitive.
  els.video.style.transform = state.facingMode === "user" ? "scaleX(-1)" : "scaleX(1)";
  await els.video.play();
  setPill(els.cam, `cam: ${state.facingMode === "user" ? "front" : "rear"} ${els.video.videoWidth}x${els.video.videoHeight}`, "ok");
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) { setPill(els.wake, "wake: n/a"); return; }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    setPill(els.wake, "wake: on", "ok");
    state.wakeLock.addEventListener("release", () => setPill(els.wake, "wake: off"));
  } catch (e) {
    setPill(els.wake, "wake: denied", "bad");
  }
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.running && !state.wakeLock) {
    await acquireWakeLock();
  }
});

async function initModel() {
  setPill(els.model, "model: loading");
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm"
  );
  state.landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  });
  setPill(els.model, "model: ready", "ok");
}

// Extract Tait-Bryan angles (yaw, pitch, roll) from a column-major 4x4 transform.
// Convention: yaw = rotation around Y, pitch = around X, roll = around Z.
function eulerFromMatrix(m) {
  const r00 = m[0], r10 = m[1], r20 = m[2];
  const r21 = m[6];
  const r22 = m[10];
  const pitch = Math.atan2(-r20, Math.hypot(r21, r22));
  const yaw = Math.atan2(r10, r00);
  const roll = Math.atan2(r21, r22);
  return { yaw, pitch, roll };
}

// One Euro Filter — smoothing without lag.
class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  alpha(cutoff, dt) {
    const r = 2 * Math.PI * cutoff * dt;
    return r / (r + 1);
  }
  filter(value, t) {
    if (this.t == null) { this.t = t; this.x = value; return value; }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const dx = (value - this.x) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    this.dx = aD * dx + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = this.alpha(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

const filters = {
  yaw: new OneEuro(), pitch: new OneEuro(), roll: new OneEuro(),
  x: new OneEuro({ minCutoff: 1.5, beta: 0.05 }),
  y: new OneEuro({ minCutoff: 1.5, beta: 0.05 }),
  z: new OneEuro({ minCutoff: 1.5, beta: 0.05 }),
};

// Sensitivity: rad → degrees (OpenTrack expects degrees) and translation scaling.
const SENS = { yaw: 2.0, pitch: 2.0, roll: 1.0, x: 100, y: 100, z: 100 };

function computePose(matrix) {
  const { yaw, pitch, roll } = eulerFromMatrix(matrix);
  // Translation is in column 3 of column-major 4x4: indices 12,13,14
  const tx = matrix[12], ty = matrix[13], tz = matrix[14];
  return { yaw, pitch, roll, x: tx, y: ty, z: tz };
}

function applyCenterAndScale(pose) {
  const c = state.center;
  if (!c) return null;
  const yaw = (pose.yaw - c.yaw) * (180 / Math.PI) * SENS.yaw;
  const pitch = (pose.pitch - c.pitch) * (180 / Math.PI) * SENS.pitch;
  const roll = (pose.roll - c.roll) * (180 / Math.PI) * SENS.roll;
  const x = (pose.x - c.x) * SENS.x;
  const y = (pose.y - c.y) * SENS.y;
  const z = (pose.z - c.z) * SENS.z;
  return { yaw, pitch, roll, x, y, z };
}

async function loop() {
  if (!state.running) return;
  const now = performance.now();
  const result = state.landmarker.detectForVideo(els.video, now);
  const matrices = result.facialTransformationMatrixes;
  if (matrices && matrices.length > 0) {
    const m = matrices[0].data;
    const raw = computePose(m);
    if (!state.center) state.center = { ...raw };
    const out = applyCenterAndScale(raw);
    if (out) {
      const t = performance.now();
      const filtered = {
        yaw: filters.yaw.filter(out.yaw, t),
        pitch: filters.pitch.filter(out.pitch, t),
        roll: filters.roll.filter(out.roll, t),
        x: filters.x.filter(out.x, t),
        y: filters.y.filter(out.y, t),
        z: filters.z.filter(out.z, t),
      };
      if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(filtered));
      if (t - state.lastSendAt > 100) {
        state.lastSendAt = t;
        els.stats.textContent =
          `yaw ${filtered.yaw.toFixed(1)}°  pitch ${filtered.pitch.toFixed(1)}°  roll ${filtered.roll.toFixed(1)}°\n` +
          `x ${filtered.x.toFixed(1)}  y ${filtered.y.toFixed(1)}  z ${filtered.z.toFixed(1)}`;
      }
    }
  }
  state.frames++;
  if (now - state.fpsAt > 1000) {
    setPill(els.model, `model: ${state.frames} fps`, "ok");
    state.frames = 0; state.fpsAt = now;
  }
  requestAnimationFrame(loop);
}

els.start.addEventListener("click", async () => {
  els.start.disabled = true;
  try {
    connectWS();
    await initCamera();
    await initModel();
    await acquireWakeLock();
    state.running = true;
    requestAnimationFrame(loop);
  } catch (e) {
    setPill(els.cam, "cam: error", "bad");
    console.error(e);
    els.start.disabled = false;
  }
});

els.recenter.addEventListener("click", () => { state.center = null; });

els.flip.addEventListener("click", async () => {
  state.facingMode = state.facingMode === "user" ? "environment" : "user";
  state.center = null;
  if (state.running) {
    try { await initCamera(); }
    catch (e) {
      state.facingMode = state.facingMode === "user" ? "environment" : "user";
      await initCamera();
    }
  }
});
