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
  pauseResume: document.getElementById("pauseResume"),
  calibrate: document.getElementById("calibrate"),
  cal: document.getElementById("cal"),
  calStep: document.getElementById("cal-step"),
  calArrow: document.getElementById("cal-arrow"),
  calTitle: document.getElementById("cal-title"),
  calSub: document.getElementById("cal-sub"),
  calNum: document.getElementById("cal-num"),
  calRing: document.getElementById("cal-ring"),
  calSkip: document.getElementById("cal-skip"),
  calCancel: document.getElementById("cal-cancel"),
};

// Target output ranges sent to OpenTrack (degrees / centimeters).
const TARGET = {
  yaw: 90, pitch: 60, roll: 0,
  x: 15, y: 0, z: 15,
};

const CAL_STORAGE_KEY = "tracksmfs.calibration.v1";
const RAW_KEYS = ["yaw", "pitch", "roll", "x", "y", "z"];

function emptyCalibration() {
  const ranges = {};
  for (const k of RAW_KEYS) ranges[k] = { min: 0, max: 0 };
  return { center: null, ranges };
}

function loadCalibration() {
  try {
    const raw = localStorage.getItem(CAL_STORAGE_KEY);
    if (!raw) return emptyCalibration();
    const parsed = JSON.parse(raw);
    if (!parsed?.center || !parsed?.ranges) return emptyCalibration();
    return parsed;
  } catch {
    return emptyCalibration();
  }
}

function saveCalibration(cal) {
  try { localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(cal)); } catch {}
}

const state = {
  ws: null,
  landmarker: null,
  running: false,
  paused: false,
  suppressUntil: 0,
  lastSendAt: 0,
  frames: 0,
  fpsAt: performance.now(),
  facingMode: "user",
  wakeLock: null,
  calibration: loadCalibration(),
  calRunning: false,
  calCancelRequested: false,
  lastRaw: null,
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
  await new Promise((res) => {
    if (els.video.readyState >= 2) return res();
    els.video.addEventListener("loadeddata", res, { once: true });
  });
  await els.video.play();
  setPill(els.cam, `cam: ${state.facingMode === "user" ? "front" : "rear"} ${els.video.videoWidth}x${els.video.videoHeight}`, "ok");
}

function resetFilters() {
  for (const k of RAW_KEYS) {
    const f = filters[k];
    if (f) { f.x = null; f.dx = 0; f.t = null; }
  }
  state.lastRaw = null;
}

function suppressFor(ms) {
  state.suppressUntil = performance.now() + ms;
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

// Fallback ranges in raw units, used before calibration is run.
const FALLBACK = {
  yaw: { min: -0.5, max: 0.5 },     // ~28°
  pitch: { min: -0.4, max: 0.4 },   // ~23°
  roll: { min: -0.4, max: 0.4 },
  x: { min: -3, max: 3 },           // model space cm
  y: { min: -3, max: 3 },
  z: { min: -5, max: 5 },
};

function computePose(matrix) {
  const { yaw, pitch, roll } = eulerFromMatrix(matrix);
  // Translation is in column 3 of column-major 4x4: indices 12,13,14
  const tx = matrix[12], ty = matrix[13], tz = matrix[14];
  return { yaw, pitch, roll, x: tx, y: ty, z: tz };
}

// Map a centered raw value to the target output range using each side
// of the user's calibrated movement independently.
function mapAxis(value, range, target) {
  if (target === 0) return 0;
  if (value >= 0) {
    const span = Math.max(1e-6, range.max);
    return Math.max(-target, Math.min(target, (value / span) * target));
  } else {
    const span = Math.max(1e-6, -range.min);
    return Math.max(-target, Math.min(target, (value / span) * target));
  }
}

function applyCenterAndScale(pose) {
  const c = state.calibration?.center;
  if (!c) return null;
  const ranges = state.calibration.ranges;
  // Subtract center first, then map per-axis using calibrated min/max.
  const centered = {};
  for (const k of RAW_KEYS) centered[k] = pose[k] - c[k];
  return {
    yaw: mapAxis(centered.yaw, ranges.yaw, TARGET.yaw),
    pitch: mapAxis(centered.pitch, ranges.pitch, TARGET.pitch),
    roll: mapAxis(centered.roll, ranges.roll, TARGET.roll),
    x: mapAxis(centered.x, ranges.x, TARGET.x),
    y: mapAxis(centered.y, ranges.y, TARGET.y),
    z: mapAxis(centered.z, ranges.z, TARGET.z),
  };
}

async function loop() {
  if (!state.running) return;
  const now = performance.now();
  const result = state.landmarker.detectForVideo(els.video, now);
  const matrices = result.facialTransformationMatrixes;
  if (matrices && matrices.length > 0) {
    const m = matrices[0].data;
    const raw = computePose(m);
    state.lastRaw = raw;
    // First-run bootstrap: if no calibration, seed center + fallback ranges
    // so tracking still works while the user has not run the wizard yet.
    if (!state.calibration.center) {
      state.calibration.center = { ...raw };
      state.calibration.ranges = JSON.parse(JSON.stringify(FALLBACK));
    }
    const tNow = performance.now();
    const sending = !state.calRunning && !state.paused && tNow >= state.suppressUntil;
    const out = sending ? applyCenterAndScale(raw) : null;
    if (out) {
      const t = tNow;
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

els.recenter.addEventListener("click", () => {
  if (state.lastRaw) {
    state.calibration.center = { ...state.lastRaw };
    saveCalibration(state.calibration);
    resetFilters();
    state.suppressUntil = 0;
  }
});

els.pauseResume.addEventListener("click", () => {
  if (state.paused) {
    state.paused = false;
    state.suppressUntil = 0;
    resetFilters();
    if (state.lastRaw) {
      state.calibration.center = { ...state.lastRaw };
      saveCalibration(state.calibration);
    }
    els.pauseResume.textContent = "Pause";
    setPill(els.cam, `cam: ${state.facingMode === "user" ? "front" : "rear"} ${els.video.videoWidth}x${els.video.videoHeight}`, "ok");
  } else {
    state.paused = true;
    els.pauseResume.textContent = "Resume";
  }
});

els.flip.addEventListener("click", async () => {
  if (els.flip.disabled) return;
  els.flip.disabled = true;
  const previous = state.facingMode;
  state.facingMode = previous === "user" ? "environment" : "user";
  // Stop sending until the new stream is settled and the user has had
  // time to reposition the phone.
  suppressFor(60_000);
  resetFilters();
  if (state.running) {
    try { await initCamera(); }
    catch (e) {
      state.facingMode = previous;
      await initCamera();
    }
  }
  // Drop the suppression window early once Resume / Re-center is pressed.
  setPill(els.cam, `cam: position phone, then Resume`, "ok");
  state.paused = true;
  els.pauseResume.textContent = "Resume";
  els.flip.disabled = false;
});

// ----- Calibration wizard -----------------------------------------------

const STEPS = [
  { axis: null,    sign: 0,  arrow: "·",  title: "Look straight ahead",        sub: "Stay centered and still.",                  duration: 3000 },
  { axis: "yaw",   sign: -1, arrow: "←",  title: "Turn head fully left",       sub: "Eyes follow. Don't move shoulders.",         duration: 5000 },
  { axis: "yaw",   sign: +1, arrow: "→",  title: "Turn head fully right",      sub: "Eyes follow. Don't move shoulders.",         duration: 5000 },
  { axis: "pitch", sign: +1, arrow: "↑",  title: "Look up",                    sub: "Tilt your head up as far as comfortable.",   duration: 5000 },
  { axis: "pitch", sign: -1, arrow: "↓",  title: "Look down",                  sub: "Tilt your head down as far as comfortable.", duration: 5000 },
  { axis: "x",     sign: -1, arrow: "↤",  title: "Lean head to the left",      sub: "Translate (slide) head left, not tilt.",     duration: 5000 },
  { axis: "x",     sign: +1, arrow: "↦",  title: "Lean head to the right",     sub: "Translate (slide) head right, not tilt.",    duration: 5000 },
  { axis: "z",     sign: +1, arrow: "⊕",  title: "Move head closer",           sub: "Lean toward the camera.",                    duration: 5000 },
  { axis: "z",     sign: -1, arrow: "⊖",  title: "Move head back",             sub: "Lean away from the camera.",                 duration: 5000 },
];

const CIRCUMFERENCE = 2 * Math.PI * 46;

function showCalUI(step, idx) {
  els.cal.classList.add("show");
  els.calStep.textContent = `Step ${idx + 1} / ${STEPS.length}`;
  els.calArrow.textContent = step.arrow;
  els.calTitle.textContent = step.title;
  els.calSub.textContent = step.sub;
}

function setCalProgress(elapsed, duration) {
  const remaining = Math.max(0, duration - elapsed) / 1000;
  els.calNum.textContent = Math.ceil(remaining).toString();
  const ratio = Math.min(1, elapsed / duration);
  els.calRing.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - ratio));
}

function hideCalUI() {
  els.cal.classList.remove("show");
}

async function waitFreshFrame() {
  // Poll until detectForVideo has produced a fresh raw pose this session.
  const t0 = performance.now();
  while (!state.lastRaw && performance.now() - t0 < 3000) {
    await new Promise((r) => requestAnimationFrame(r));
  }
}

async function runCalibrationStep(step, idx) {
  showCalUI(step, idx);
  const start = performance.now();
  let peak = 0;     // signed peak magnitude on the chosen side
  const centerSnapshot = state.calibration.center
    ? { ...state.calibration.center }
    : (state.lastRaw ? { ...state.lastRaw } : null);
  // Average buffer for the centering step.
  const centerBuf = { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 };
  let centerCount = 0;

  return new Promise((resolve) => {
    function tick() {
      if (state.calCancelRequested) return resolve({ cancelled: true });
      const elapsed = performance.now() - start;
      setCalProgress(elapsed, step.duration);

      const raw = state.lastRaw;
      if (raw) {
        if (step.axis === null) {
          for (const k of RAW_KEYS) centerBuf[k] += raw[k];
          centerCount++;
        } else if (centerSnapshot) {
          const v = raw[step.axis] - centerSnapshot[step.axis];
          if (step.sign > 0 && v > peak) peak = v;
          if (step.sign < 0 && v < peak) peak = v;
        }
      }

      const finished = elapsed >= step.duration || state._skipStep;
      if (finished) {
        state._skipStep = false;
        if (step.axis === null && centerCount > 0) {
          const avg = {};
          for (const k of RAW_KEYS) avg[k] = centerBuf[k] / centerCount;
          state.calibration.center = avg;
        } else if (step.axis && peak !== 0) {
          const range = state.calibration.ranges[step.axis];
          if (step.sign > 0) range.max = peak;
          else range.min = peak;
        }
        return resolve({ cancelled: false, skipped: false });
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

async function runCalibration() {
  if (state.calRunning) return;
  if (!state.running) {
    alert("Press Start first to enable the camera.");
    return;
  }
  state.calRunning = true;
  state.calCancelRequested = false;
  const fresh = emptyCalibration();
  fresh.ranges = JSON.parse(JSON.stringify(FALLBACK));
  state.calibration = fresh;

  await waitFreshFrame();

  for (let i = 0; i < STEPS.length; i++) {
    const r = await runCalibrationStep(STEPS[i], i);
    if (r.cancelled) {
      state.calRunning = false;
      hideCalUI();
      state.calibration = loadCalibration();
      return;
    }
  }

  // Sanity: if a side was not captured (peak still 0), fall back to FALLBACK.
  for (const k of RAW_KEYS) {
    const r = state.calibration.ranges[k];
    if (r.min === 0) r.min = FALLBACK[k].min;
    if (r.max === 0) r.max = FALLBACK[k].max;
  }
  saveCalibration(state.calibration);
  state.calRunning = false;
  hideCalUI();
}

els.calibrate.addEventListener("click", runCalibration);
els.calCancel.addEventListener("click", () => { state.calCancelRequested = true; });
els.calSkip.addEventListener("click", () => { state._skipStep = true; });
