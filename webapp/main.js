import { FilesetResolver, FaceLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs";

const els = {
  video: document.getElementById("video"),
  ws: document.getElementById("ws"),
  cam: document.getElementById("cam"),
  model: document.getElementById("model"),
  pc: document.getElementById("pc"),
  state: document.getElementById("state"),
  permission: document.getElementById("permission"),
  grant: document.getElementById("grant"),
  overlay: document.getElementById("overlay"),
  ovlSmall: document.getElementById("ovl-small"),
  ovlArrow: document.getElementById("ovl-arrow"),
  ovlTitle: document.getElementById("ovl-title"),
  ovlSub: document.getElementById("ovl-sub"),
  ovlNum: document.getElementById("ovl-num"),
  ovlRing: document.getElementById("ovl-ring"),
};

const CIRC = 2 * Math.PI * 46;
const CAL_KEY = "tracksmfs.calibration.v2";
const RAW_KEYS = ["yaw", "pitch", "roll", "x", "y", "z"];

// La caméra arrière voit ton visage en symétrique horizontal → on inverse
// le yaw et le X bruts pour rester cohérent avec la calibration et les axes.
const REAR_CAMERA_FLIP = { yaw: -1, pitch: 1, roll: -1, x: -1, y: 1, z: 1 };

const TARGET = { yaw: 90, pitch: 60, roll: 0, x: 15, y: 0, z: 15 };
const FALLBACK = {
  yaw:   { min: -0.5, max: 0.5 },
  pitch: { min: -0.4, max: 0.4 },
  roll:  { min: -0.4, max: 0.4 },
  x: { min: -3, max: 3 },
  y: { min: -3, max: 3 },
  z: { min: -5, max: 5 },
};

function emptyCalibration() {
  const ranges = {};
  for (const k of RAW_KEYS) ranges[k] = { ...FALLBACK[k] };
  return { center: null, ranges };
}

function loadCalibration() {
  try {
    const raw = localStorage.getItem(CAL_KEY);
    if (!raw) return emptyCalibration();
    const p = JSON.parse(raw);
    if (!p?.center || !p?.ranges) return emptyCalibration();
    return p;
  } catch { return emptyCalibration(); }
}
function saveCalibration(c) { try { localStorage.setItem(CAL_KEY, JSON.stringify(c)); } catch {} }

const state = {
  ws: null,
  landmarker: null,
  cameraReady: false,
  modelReady: false,
  // mode: idle | countdown | active | paused | calibrating
  mode: "idle",
  pcConnected: false,
  calibration: loadCalibration(),
  lastRaw: null,
  wakeLock: null,
  // calibration runtime
  calStepIdx: 0,
  calStepStart: 0,
  calCenterBuf: { yaw: 0, pitch: 0, roll: 0, x: 0, y: 0, z: 0 },
  calCenterCount: 0,
  calPeak: 0,
  // countdown
  countdownEndAt: 0,
};

function setPill(el, text, cls) {
  el.textContent = text;
  el.className = "pill" + (cls ? " " + cls : "");
}

function setOverlay(opts = null) {
  if (!opts) { els.overlay.classList.remove("show"); return; }
  els.overlay.classList.add("show");
  els.ovlSmall.textContent = opts.small ?? "";
  els.ovlTitle.textContent = opts.title ?? "";
  els.ovlSub.textContent = opts.sub ?? "";
  if (opts.arrow) { els.ovlArrow.textContent = opts.arrow; els.ovlArrow.style.display = ""; }
  else els.ovlArrow.style.display = "none";
  if (opts.num != null) els.ovlNum.textContent = String(opts.num);
  if (opts.ratio != null) els.ovlRing.style.strokeDashoffset = String(CIRC * (1 - Math.min(1, Math.max(0, opts.ratio))));
}

function setStatePill() {
  const map = {
    idle:        { text: "en attente",    cls: "" },
    countdown:   { text: "démarrage…",    cls: "warn" },
    active:      { text: "actif",         cls: "ok" },
    paused:      { text: "en pause",      cls: "warn" },
    calibrating: { text: "calibration",   cls: "warn" },
  };
  const m = map[state.mode] ?? map.idle;
  setPill(els.state, m.text, m.cls);
}

// ----- WebSocket ---------------------------------------------------------

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/sender`);
  ws.addEventListener("open", () => setPill(els.ws, "ws : connecté", "ok"));
  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg && typeof msg === "object" && msg.type) handleCommand(msg);
    } catch {}
  });
  ws.addEventListener("close", () => {
    setPill(els.ws, "ws : déconnecté", "bad");
    setTimeout(connectWS, 1000);
  });
  ws.addEventListener("error", () => setPill(els.ws, "ws : erreur", "bad"));
  state.ws = ws;
}

function send(obj) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(obj));
}

function handleCommand(msg) {
  switch (msg.type) {
    case "senderState":
      // (informational, sent by relay; ignore here)
      return;
    case "pcState":
      state.pcConnected = !!msg.connected;
      setPill(els.pc, state.pcConnected ? "pc : connecté" : "pc : absent", state.pcConnected ? "ok" : "bad");
      return;
    case "start":
      startCountdown(Number(msg.delay ?? 10));
      return;
    case "pause":
      if (state.mode === "active") { state.mode = "paused"; setStatePill(); }
      return;
    case "resume":
      if (state.mode === "paused") { state.mode = "active"; setStatePill(); }
      return;
    case "stop":
      state.mode = "idle";
      setOverlay(null);
      setStatePill();
      return;
    case "recenter":
      if (state.lastRaw) {
        state.calibration.center = { ...state.lastRaw };
        saveCalibration(state.calibration);
      }
      return;
    case "calibrate":
      runCalibration();
      return;
  }
}

// ----- Camera + Model ----------------------------------------------------

async function initCamera() {
  setPill(els.cam, "caméra : demande…");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 },
    },
  });
  els.video.srcObject = stream;
  await new Promise((res) => {
    if (els.video.readyState >= 2) return res();
    els.video.addEventListener("loadeddata", res, { once: true });
  });
  await els.video.play();
  setPill(els.cam, `caméra : arrière ${els.video.videoWidth}×${els.video.videoHeight}`, "ok");
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

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && !state.wakeLock) await acquireWakeLock();
});

// ----- Pose extraction ---------------------------------------------------

function eulerFromMatrix(m) {
  const r10 = m[1];
  const r02 = m[8];
  const r12 = m[9];
  const r22 = m[10];
  const r11 = m[5];
  const r00 = m[0];
  const r20 = m[2];
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)));
  let yaw, roll;
  if (Math.abs(r12) < 0.9999) {
    yaw  = Math.atan2(r02, r22);
    roll = Math.atan2(r10, r11);
  } else {
    yaw = Math.atan2(-r20, r00);
    roll = 0;
  }
  return { yaw, pitch, roll };
}

function computePose(matrix) {
  const e = eulerFromMatrix(matrix);
  const tx = matrix[12], ty = matrix[13], tz = matrix[14];
  const raw = { yaw: e.yaw, pitch: e.pitch, roll: e.roll, x: tx, y: ty, z: tz };
  for (const k of RAW_KEYS) raw[k] *= REAR_CAMERA_FLIP[k];
  return raw;
}

function mapAxis(value, range, target) {
  if (target === 0) return 0;
  if (value >= 0) {
    const span = Math.max(1e-6, range.max);
    return Math.max(-target, Math.min(target, (value / span) * target));
  }
  const span = Math.max(1e-6, -range.min);
  return Math.max(-target, Math.min(target, (value / span) * target));
}

function applyCenterAndScale(pose) {
  const c = state.calibration?.center;
  if (!c) return null;
  const r = state.calibration.ranges;
  const ce = {};
  for (const k of RAW_KEYS) ce[k] = pose[k] - c[k];
  return {
    yaw: mapAxis(ce.yaw, r.yaw, TARGET.yaw),
    pitch: mapAxis(ce.pitch, r.pitch, TARGET.pitch),
    roll: mapAxis(ce.roll, r.roll, TARGET.roll),
    x: mapAxis(ce.x, r.x, TARGET.x),
    y: mapAxis(ce.y, r.y, TARGET.y),
    z: mapAxis(ce.z, r.z, TARGET.z),
  };
}

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
function resetFilters() { for (const k of RAW_KEYS) { const f = filters[k]; f.x = null; f.dx = 0; f.t = null; } }

// ----- Calibration wizard (driven by PC, displayed on phone) ------------

const STEPS = [
  { axis: null,    sign: 0,  arrow: "·",  title: "Regarde droit devant",          sub: "Reste centré et immobile.",                    duration: 3000 },
  { axis: "yaw",   sign: -1, arrow: "←",  title: "Tourne la tête à fond à gauche", sub: "Sans bouger les épaules.",                    duration: 5000 },
  { axis: "yaw",   sign: +1, arrow: "→",  title: "Tourne la tête à fond à droite", sub: "Sans bouger les épaules.",                    duration: 5000 },
  { axis: "pitch", sign: +1, arrow: "↑",  title: "Regarde en haut",                sub: "Lève la tête au max confortable.",            duration: 5000 },
  { axis: "pitch", sign: -1, arrow: "↓",  title: "Regarde en bas",                 sub: "Baisse la tête au max confortable.",          duration: 5000 },
  { axis: "x",     sign: -1, arrow: "↤",  title: "Glisse la tête à gauche",        sub: "Translation latérale, ne penche pas.",        duration: 5000 },
  { axis: "x",     sign: +1, arrow: "↦",  title: "Glisse la tête à droite",        sub: "Translation latérale, ne penche pas.",        duration: 5000 },
  { axis: "z",     sign: +1, arrow: "⊕",  title: "Approche la tête",               sub: "Avance vers la caméra.",                       duration: 5000 },
  { axis: "z",     sign: -1, arrow: "⊖",  title: "Recule la tête",                 sub: "Recule par rapport à la caméra.",              duration: 5000 },
];

function startCountdown(seconds) {
  if (!state.cameraReady || !state.modelReady) return;
  state.mode = "countdown";
  state.countdownEndAt = performance.now() + seconds * 1000;
  setStatePill();
}

function startCalibrationStep(idx) {
  state.calStepIdx = idx;
  state.calStepStart = performance.now();
  state.calPeak = 0;
  state.calCenterCount = 0;
  for (const k of RAW_KEYS) state.calCenterBuf[k] = 0;
}

function runCalibration() {
  if (!state.cameraReady || !state.modelReady) return;
  state.mode = "calibrating";
  // reset calibration entirely
  state.calibration = emptyCalibration();
  startCalibrationStep(0);
  setStatePill();
}

function onCalibrationFrameDone(idx) {
  const step = STEPS[idx];
  if (step.axis === null) {
    if (state.calCenterCount > 0) {
      const avg = {};
      for (const k of RAW_KEYS) avg[k] = state.calCenterBuf[k] / state.calCenterCount;
      state.calibration.center = avg;
    }
  } else if (state.calPeak !== 0) {
    const r = state.calibration.ranges[step.axis];
    if (step.sign > 0) r.max = state.calPeak;
    else r.min = state.calPeak;
  }
  if (idx + 1 < STEPS.length) {
    startCalibrationStep(idx + 1);
  } else {
    saveCalibration(state.calibration);
    state.mode = "active";
    setOverlay(null);
    setStatePill();
    send({ type: "calibrationDone" });
  }
}

// ----- Main loop ---------------------------------------------------------

function loop() {
  if (state.cameraReady && state.modelReady) {
    const now = performance.now();
    const result = state.landmarker.detectForVideo(els.video, now);
    const matrices = result.facialTransformationMatrixes;
    if (matrices && matrices.length > 0) {
      const raw = computePose(matrices[0].data);
      state.lastRaw = raw;
      // First-run bootstrap (in case calibration is empty)
      if (!state.calibration.center) state.calibration.center = { ...raw };

      if (state.mode === "calibrating") {
        const step = STEPS[state.calStepIdx];
        const elapsed = now - state.calStepStart;
        if (step.axis === null) {
          for (const k of RAW_KEYS) state.calCenterBuf[k] += raw[k];
          state.calCenterCount++;
        } else if (state.calibration.center) {
          const v = raw[step.axis] - state.calibration.center[step.axis];
          if (step.sign > 0 && v > state.calPeak) state.calPeak = v;
          if (step.sign < 0 && v < state.calPeak) state.calPeak = v;
        }
        const remaining = Math.max(0, step.duration - elapsed) / 1000;
        setOverlay({
          small: `Étape ${state.calStepIdx + 1} / ${STEPS.length}`,
          arrow: step.arrow,
          title: step.title,
          sub: step.sub,
          num: Math.ceil(remaining),
          ratio: Math.min(1, elapsed / step.duration),
        });
        if (elapsed >= step.duration) onCalibrationFrameDone(state.calStepIdx);
      } else if (state.mode === "countdown") {
        const remaining = state.countdownEndAt - now;
        if (remaining <= 0) {
          state.mode = "active";
          setOverlay(null);
          resetFilters();
          setStatePill();
        } else {
          const total = 10000; // visual ring assumes ~10s, but works for any duration
          setOverlay({
            small: "Place le téléphone derrière toi",
            title: "Démarrage du tracking",
            num: Math.ceil(remaining / 1000),
            ratio: 1 - (remaining / total),
          });
        }
      } else if (state.mode === "active") {
        const out = applyCenterAndScale(raw);
        if (out) {
          const t = now;
          const filtered = {
            yaw: filters.yaw.filter(out.yaw, t),
            pitch: filters.pitch.filter(out.pitch, t),
            roll: filters.roll.filter(out.roll, t),
            x: filters.x.filter(out.x, t),
            y: filters.y.filter(out.y, t),
            z: filters.z.filter(out.z, t),
          };
          send(filtered);
        }
      }
    }
  }
  requestAnimationFrame(loop);
}

// ----- Bootstrap ---------------------------------------------------------

async function bootstrap() {
  try {
    await initCamera();
  } catch (e) {
    setPill(els.cam, "caméra : refusée", "bad");
    els.permission.classList.remove("hidden");
    return;
  }
  try {
    await initModel();
  } catch (e) {
    setPill(els.model, "modèle : erreur", "bad");
    return;
  }
  acquireWakeLock();
  els.permission.classList.add("hidden");
  setStatePill();
  requestAnimationFrame(loop);
}

els.grant.addEventListener("click", () => {
  // The user gesture allows getUserMedia + WakeLock + autoplay.
  bootstrap();
});

// Try to connect to the relay immediately so the PC sees us.
connectWS();

// On iOS, getUserMedia and WakeLock both require a user gesture, so we
// keep the permission overlay visible until the user taps "Autoriser".
