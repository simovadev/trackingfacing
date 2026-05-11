// Local PC webcam tracker.
//
// Same MediaPipe FaceLandmarker pipeline as the iPhone webapp, but
// running directly in the user's PC browser (Chrome / Edge) and
// POSTing the resulting head pose to the local connector. No
// Railway, no relay, no phone. Latency is ~16–25 ms total (camera +
// MediaPipe) since everything runs on localhost.

import {
  FilesetResolver,
  FaceLandmarker,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs";

const els = {
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  cam: document.getElementById("cam"),
  model: document.getElementById("model"),
  pipe: document.getElementById("pipe"),
  fps: document.getElementById("fps"),
  start: document.getElementById("start"),
  recenter: document.getElementById("recenter"),
  sendEnabled: document.getElementById("sendEnabled"),
  overlayEnabled: document.getElementById("overlayEnabled"),
};

const RAW_KEYS = ["yaw", "pitch", "roll", "x", "y", "z"];

function setPill(el, text, cls) {
  el.textContent = text;
  el.className = "pill" + (cls ? " " + cls : "");
}

// ----- Euler extraction (same convention as the phone) -----------------

function eulerFromMatrix(m) {
  const r01 = m[1], r05 = m[5], r02 = m[2], r06 = m[6], r10 = m[10];
  const sp = Math.max(-1, Math.min(1, r06));
  const pitch = Math.asin(sp);
  let yaw, roll;
  if (Math.abs(sp) < 0.9999) {
    yaw  = Math.atan2(-r02, r10);
    roll = Math.atan2(-r01, r05);
  } else {
    yaw  = Math.atan2(m[8], m[0]);
    roll = 0;
  }
  return { yaw, pitch, roll };
}

// The on-PC webcam is NOT mirrored at the sensor level (unlike the
// rear camera on iPhone). The user is looking at themselves through
// the regular front cam, so we DON'T flip yaw/X here. The video
// element is mirrored via CSS for display only.
function computePose(matrix, landmarks) {
  const e = eulerFromMatrix(matrix);
  const tz = matrix[14];
  let nx = 0, ny = 0;
  if (landmarks && landmarks.length > 1) {
    const nose = landmarks[1];
    nx = (nose.x - 0.5) * 50;
    ny = (0.5 - nose.y) * 50;
  }
  return {
    yaw:   e.yaw,
    pitch: e.pitch,
    roll:  e.roll,
    x:     nx,
    y:     ny,
    z:     tz,
  };
}

// ----- One Euro filter (smoothing without lag) -------------------------

class OneEuro {
  constructor({ minCutoff = 1.0, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = null;
  }
  alpha(c, dt) { const r = 2 * Math.PI * c * dt; return r / (r + 1); }
  filter(v, t) {
    if (this.t == null) { this.t = t; this.x = v; return v; }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const dx = (v - this.x) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    this.dx = aD * dx + (1 - aD) * this.dx;
    const a = this.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x = a * v + (1 - a) * this.x;
    return this.x;
  }
}
const filters = {
  yaw: new OneEuro(), pitch: new OneEuro(), roll: new OneEuro(),
  x: new OneEuro({ minCutoff: 1.5, beta: 0.05 }),
  y: new OneEuro({ minCutoff: 1.5, beta: 0.05 }),
  z: new OneEuro({ minCutoff: 1.5, beta: 0.05 }),
};
function resetFilters() {
  for (const k of RAW_KEYS) {
    const f = filters[k]; f.x = null; f.dx = 0; f.t = null;
  }
}

// ----- Calibration: just a center subtraction. Range is fixed in CM /
// degrees; the connector tuner already has gain / expo sliders.

const TARGET = { yaw: 90, pitch: 60, roll: 30, x: 15, y: 15, z: 15 };
const FALLBACK = {
  yaw:   { min: -0.5, max: 0.5 },
  pitch: { min: -0.4, max: 0.4 },
  roll:  { min: -0.4, max: 0.4 },
  x:     { min: -8, max: 8 },
  y:     { min: -8, max: 8 },
  z:     { min: -5, max: 5 },
};

const state = {
  running: false,
  cameraReady: false,
  modelReady: false,
  landmarker: null,
  center: null,
  lastRaw: null,
  frames: 0,
  fpsAt: performance.now(),
};

function mapAxis(value, range, target) {
  if (target === 0) return 0;
  if (!Number.isFinite(value) || !range) return 0;
  if (value >= 0) {
    const span = range.max;
    if (!Number.isFinite(span) || span <= 1e-6) return 0;
    return Math.max(-target, Math.min(target, (value / span) * target));
  }
  const span = -range.min;
  if (!Number.isFinite(span) || span <= 1e-6) return 0;
  return Math.max(-target, Math.min(target, (value / span) * target));
}

function applyCenterAndScale(raw) {
  if (!state.center) return null;
  const ce = {};
  for (const k of RAW_KEYS) ce[k] = raw[k] - state.center[k];
  // Distance compensation: scale X/Y by |Z| / |Zref| so the sensitivity
  // stays consistent across distances.
  const zRef = Math.abs(state.center.z) || 50;
  const zNow = Math.max(1, Math.abs(raw.z) || zRef);
  const distScale = zNow / zRef;
  ce.x *= distScale;
  ce.y *= distScale;
  return {
    yaw:   mapAxis(ce.yaw,   FALLBACK.yaw,   TARGET.yaw),
    pitch: mapAxis(ce.pitch, FALLBACK.pitch, TARGET.pitch),
    roll:  mapAxis(ce.roll,  FALLBACK.roll,  TARGET.roll),
    x:     mapAxis(ce.x,     FALLBACK.x,     TARGET.x),
    y:     mapAxis(ce.y,     FALLBACK.y,     TARGET.y),
    z:     mapAxis(ce.z,     FALLBACK.z,     TARGET.z),
  };
}

// ----- Camera + model init -------------------------------------------

async function initCamera() {
  setPill(els.cam, "caméra : demande…");
  // Use the default user-facing webcam at 1280x720.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
  });
  els.video.srcObject = stream;
  await new Promise((res) => {
    if (els.video.readyState >= 2) return res();
    els.video.addEventListener("loadeddata", res, { once: true });
  });
  await els.video.play();
  setPill(els.cam, `caméra : ${els.video.videoWidth}×${els.video.videoHeight}`, "ok");
  state.cameraReady = true;
}

async function initModel() {
  setPill(els.model, "modèle : chargement…");
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
  setPill(els.model, "modèle : prêt", "ok");
  state.modelReady = true;
}

// ----- Overlay drawing -----------------------------------------------

let drawingUtils = null;
function drawOverlay(landmarks) {
  if (!els.overlayEnabled.checked) {
    const ctx = els.overlay.getContext("2d");
    ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    return;
  }
  const w = els.overlay.clientWidth, h = els.overlay.clientHeight;
  if (els.overlay.width !== w || els.overlay.height !== h) {
    els.overlay.width = w; els.overlay.height = h;
  }
  const ctx = els.overlay.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (!landmarks) return;
  if (!drawingUtils) drawingUtils = new DrawingUtils(ctx);
  drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION,
    { color: "rgba(255,255,255,0.18)", lineWidth: 1 });
  drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
    { color: "#22c55e", lineWidth: 2 });
  drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
    { color: "#3b82f6", lineWidth: 2 });
  drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
    { color: "#3b82f6", lineWidth: 2 });
  drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LIPS,
    { color: "#f43f5e", lineWidth: 2 });
}

// ----- HUD bars + numeric display ------------------------------------

function setAxis(name, value, unit, max) {
  const fill = document.querySelector(`#bar-${name} .fill`);
  const val = document.getElementById(`val-${name}`);
  const norm = Math.max(-1, Math.min(1, value / max));
  if (fill) {
    if (norm >= 0) {
      fill.style.left = "50%";
      fill.style.width = (norm * 50) + "%";
    } else {
      fill.style.left = (50 + norm * 50) + "%";
      fill.style.width = (-norm * 50) + "%";
    }
  }
  if (val) val.textContent = value.toFixed(2) + " " + unit;
}

// ----- Pose POST to the local connector ------------------------------
//
// We throttle to ~60 Hz to match the head-tracking sample rate of MSFS
// and avoid spamming localhost. fetch with keepalive is fine here.

let lastPostAt = 0;
function maybePost(filtered) {
  if (!els.sendEnabled.checked) return;
  const now = performance.now();
  if (now - lastPostAt < 16) return; // ~60 Hz cap
  lastPostAt = now;
  fetch("/api/pose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(filtered),
    keepalive: true,
  }).then(() => setPill(els.pipe, "connector : actif", "ok"))
    .catch(() => setPill(els.pipe, "connector : injoignable", "bad"));
}

// ----- Main loop -----------------------------------------------------

function loop() {
  if (!state.running) return;
  const now = performance.now();
  if (state.modelReady && state.cameraReady) {
    const result = state.landmarker.detectForVideo(els.video, now);
    const landmarks = result.faceLandmarks?.[0] ?? null;
    const matrix = result.facialTransformationMatrixes?.[0]?.data ?? null;
    drawOverlay(landmarks);
    if (matrix && landmarks) {
      const raw = computePose(matrix, landmarks);
      state.lastRaw = raw;
      if (!state.center) state.center = { ...raw };
      const out = applyCenterAndScale(raw);
      if (out) {
        const t = now;
        const filtered = {
          yaw:   filters.yaw.filter(out.yaw, t),
          pitch: filters.pitch.filter(out.pitch, t),
          roll:  filters.roll.filter(out.roll, t),
          x:     filters.x.filter(out.x, t),
          y:     filters.y.filter(out.y, t),
          z:     filters.z.filter(out.z, t),
        };
        setAxis("yaw",   filtered.yaw,   "°",  TARGET.yaw);
        setAxis("pitch", filtered.pitch, "°",  TARGET.pitch);
        setAxis("roll",  filtered.roll,  "°",  TARGET.roll);
        setAxis("x",     filtered.x,     "cm", TARGET.x);
        setAxis("y",     filtered.y,     "cm", TARGET.y);
        setAxis("z",     filtered.z,     "cm", TARGET.z);
        maybePost(filtered);
      }
    }
  }
  state.frames++;
  if (now - state.fpsAt > 1000) {
    setPill(els.fps, `fps : ${state.frames}`, "ok");
    state.frames = 0; state.fpsAt = now;
  }
  requestAnimationFrame(loop);
}

// ----- Buttons -------------------------------------------------------

els.start.addEventListener("click", async () => {
  if (state.running) return;
  els.start.disabled = true;
  try {
    await initCamera();
    await initModel();
    state.running = true;
    requestAnimationFrame(loop);
    els.start.textContent = "Tracking actif";
  } catch (e) {
    setPill(els.cam, "caméra : erreur", "bad");
    console.error(e);
    els.start.disabled = false;
  }
});

els.recenter.addEventListener("click", () => {
  if (state.lastRaw) {
    state.center = { ...state.lastRaw };
    resetFilters();
  }
});
