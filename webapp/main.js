import {
  FilesetResolver,
  FaceLandmarker,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs";

const els = {
  video: document.getElementById("video"),
  gizmo: document.getElementById("gizmo"),
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

// Hidden canvas used as the WebRTC video source. We draw the camera frame
// plus optional gizmo overlay into it, and capture its stream.
const broadcastCanvas = document.createElement("canvas");
broadcastCanvas.width = 640;
broadcastCanvas.height = 360;
const broadcastCtx = broadcastCanvas.getContext("2d");
const gizmoCtx = els.gizmo.getContext("2d");
let lastLandmarks = null;
let lastMatrix = null;

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
  // X and Y now come from nose-tip 2D position scaled by 50, so a
  // typical lateral motion produces ~5-10 units. Z stays in matrix units.
  x: { min: -8, max: 8 },
  y: { min: -8, max: 8 },
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
  // camera stream + webrtc
  stream: null,
  pc: null,
  gizmoEnabled: true,
  bypass: false,
  bypassCenter: null,
  debugRecording: false,
  debugRecordingEndAt: 0,
};

// Bypass mode: send angles in degrees / translations in cm without
// calibration. Use a fixed conversion so the values are usable.
const BYPASS_DEG_GAIN = 180 / Math.PI; // rad -> deg
const BYPASS_TR_GAIN = 1.0;            // model cm pass-through

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
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
  let heartbeat = null;
  let lastPongAt = performance.now();

  ws.addEventListener("open", () => {
    setPill(els.ws, "ws : connecté", "ok");
    lastPongAt = performance.now();
    heartbeat = setInterval(() => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: "ping", t: performance.now() }));
      // Detect zombie connection: no pong in 15 s -> force close to retry.
      if (performance.now() - lastPongAt > 15000) {
        try { ws.close(); } catch {}
      }
    }, 5000);
  });
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data);
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "pong") { lastPongAt = performance.now(); return; }
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
      if (msg.type) handleCommand(msg);
    } catch {}
  });
  ws.addEventListener("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    setPill(els.ws, "ws : déconnecté", "bad");
    setTimeout(connectWS, 1000);
  });
  ws.addEventListener("error", () => setPill(els.ws, "ws : erreur", "bad"));
  state.ws = ws;
}

function send(obj) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(obj));
}

// Binary pose payload: 1 byte tag (0x01) + 6 little-endian float32.
// Total 25 bytes vs ~120 in JSON.
const POSE_BUF = new ArrayBuffer(25);
const POSE_VIEW = new DataView(POSE_BUF);
POSE_VIEW.setUint8(0, 0x01);
function sendPose(p) {
  if (state.ws?.readyState !== 1) return;
  POSE_VIEW.setFloat32(1,  p.yaw,   true);
  POSE_VIEW.setFloat32(5,  p.pitch, true);
  POSE_VIEW.setFloat32(9,  p.roll,  true);
  POSE_VIEW.setFloat32(13, p.x,     true);
  POSE_VIEW.setFloat32(17, p.y,     true);
  POSE_VIEW.setFloat32(21, p.z,     true);
  state.ws.send(POSE_BUF);
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
        state.bypassCenter = { ...state.lastRaw };
      }
      return;
    case "calibrate":
      runCalibration();
      return;
    case "rtc":
      handleRtcMessage(msg.payload);
      return;
    case "setGizmo":
      state.gizmoEnabled = !!msg.enabled;
      return;
    case "resetCalibration":
      state.calibration = emptyCalibration();
      try { localStorage.removeItem(CAL_KEY); } catch {}
      state.mode = "idle";
      setOverlay(null);
      setStatePill();
      return;
    case "setBypass":
      state.bypass = !!msg.enabled;
      state.bypassCenter = null;
      return;
    case "startDebugRecording":
      state.debugRecording = true;
      state.debugRecordingEndAt = performance.now() + Number(msg.duration ?? 5) * 1000;
      send({ type: "debugRecordingStart" });
      return;
    case "setCalibration":
      // Manually overwrite the calibration (full or partial). Useful
      // for fine-tuning ranges from the PC tuner.
      if (msg.calibration && typeof msg.calibration === "object") {
        if (msg.calibration.center) state.calibration.center = { ...msg.calibration.center };
        if (msg.calibration.ranges) {
          for (const k of RAW_KEYS) {
            if (msg.calibration.ranges[k]) {
              state.calibration.ranges[k] = { ...msg.calibration.ranges[k] };
            }
          }
        }
        saveCalibration(state.calibration);
      }
      return;
  }
}

// ----- Camera + Model ----------------------------------------------------

async function initCamera() {
  setPill(els.cam, "caméra : demande…");
  // Detect orientation: if the phone is held in portrait (most likely),
  // ask for a 720x1280 stream; in landscape we ask 1280x720. iOS/Safari
  // honors these as a hint and falls back to whatever the sensor offers.
  const portrait = window.matchMedia && window.matchMedia("(orientation: portrait)").matches;
  const w = portrait ? 720 : 1280;
  const h = portrait ? 1280 : 720;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 60 },
    },
  });
  state.stream = stream;
  els.video.srcObject = stream;
  await new Promise((res) => {
    if (els.video.readyState >= 2) return res();
    els.video.addEventListener("loadeddata", res, { once: true });
  });
  await els.video.play();
  setPill(els.cam, `caméra : arrière ${els.video.videoWidth}×${els.video.videoHeight}`, "ok");
  state.cameraReady = true;
}

// ----- WebRTC sender (camera preview to PC) -----------------------------

function rtcSend(payload) {
  send({ type: "rtc", payload });
}

async function startWebRTC() {
  if (state.pc || !state.stream) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.pc = pc;
  // Broadcast the canvas (camera + gizmo) instead of the raw camera track,
  // so the PC preview shows the gizmo without any extra channel.
  const broadcastStream = broadcastCanvas.captureStream(15);
  for (const t of broadcastStream.getVideoTracks()) pc.addTrack(t, broadcastStream);
  pc.onicecandidate = (e) => { if (e.candidate) rtcSend({ kind: "ice", candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) stopWebRTC();
  };
  const offer = await pc.createOffer({ offerToReceiveVideo: false });
  // Cap bitrate to ~250 kbps so the preview stays cheap on Shadow's uplink.
  offer.sdp = offer.sdp.replace(/a=mid:0\r\n/, "a=mid:0\r\nb=AS:250\r\n");
  await pc.setLocalDescription(offer);
  rtcSend({ kind: "offer", sdp: pc.localDescription });
}

async function handleRtcMessage(payload) {
  if (!payload || typeof payload !== "object") return;
  if (payload.kind === "request") {
    await startWebRTC();
    return;
  }
  if (payload.kind === "stop") {
    stopWebRTC();
    return;
  }
  if (!state.pc) return;
  if (payload.kind === "answer") {
    await state.pc.setRemoteDescription(payload.sdp);
    return;
  }
  if (payload.kind === "ice" && payload.candidate) {
    try { await state.pc.addIceCandidate(payload.candidate); } catch {}
  }
}

function stopWebRTC() {
  if (state.pc) { try { state.pc.close(); } catch {} state.pc = null; }
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
  // FaceLandmarker also returns 2D normalized landmarks by default.
  // We use them to draw the gizmo overlay.
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

// MediaPipe facialTransformationMatrix is column-major: R[col][row] = m[col*4+row].
// In MediaPipe camera space, +X points right, +Y points up, +Z points out of
// the screen toward the camera. Yaw = rotation around Y, pitch = rotation
// around X, roll = rotation around Z. Decomposition order is Y then X then Z
// (Ry * Rx * Rz), the standard head-tracking convention used by TrackIR.
//
// For R = Ry(yaw) * Rx(pitch) * Rz(roll):
//   pitch = asin( R[2][1] )            // = m[6]
//   yaw   = atan2( -R[2][0], R[2][2] ) // = atan2(-m[2], m[10])
//   roll  = atan2( -R[0][1], R[1][1] ) // = atan2(-m[1], m[5])
function eulerFromMatrix(m) {
  const r01 = m[1];   // R[0][1]
  const r05 = m[5];   // R[1][1]
  const r02 = m[2];   // R[2][0]
  const r06 = m[6];   // R[2][1]
  const r10 = m[10];  // R[2][2]
  const sp = Math.max(-1, Math.min(1, r06));
  const pitch = Math.asin(sp);
  let yaw, roll;
  if (Math.abs(sp) < 0.9999) {
    yaw  = Math.atan2(-r02, r10);
    roll = Math.atan2(-r01, r05);
  } else {
    // Gimbal lock: head looking straight up or down. Roll undefined.
    yaw  = Math.atan2(m[8], m[0]);
    roll = 0;
  }
  return { yaw, pitch, roll };
}

// MediaPipe's matrix translation reports the canonical face origin in
// camera space. Y barely moves when the user simply raises their head
// (most of that motion is captured as pitch). So we override X and Y
// with the position of the nose tip landmark (index 1) projected in
// normalized screen coordinates and re-expressed in face-units, which
// is dramatically more responsive for "head up/down" type movement.
//
// The phone may be held in physical portrait while the camera sensor
// is in landscape (or vice versa). MediaPipe always interprets the
// sensor as the reference frame, so when the phone is in portrait the
// world-up axis is rotated 90 deg compared to the sensor. We detect
// this from the live video dimensions and remap yaw/pitch/roll +
// nose-tip X/Y accordingly so the axes always behave as the user
// expects (yaw = turn head left/right, pitch = look up/down, etc).
function computePose(matrix, landmarks) {
  const e = eulerFromMatrix(matrix);
  const tz = matrix[14];

  // Default (landscape phone): nose X is horizontal, nose Y vertical.
  let tx = matrix[12];
  let ty = matrix[13];
  let nx = 0, ny = 0;
  if (landmarks && landmarks.length > 1) {
    const nose = landmarks[1];
    nx = (nose.x - 0.5) * 50;
    ny = (0.5 - nose.y) * 50;
  }

  // Detect orientation from the live video aspect ratio.
  const vw = els.video.videoWidth || 1;
  const vh = els.video.videoHeight || 1;
  const portrait = vh > vw;

  let yaw, pitch, roll, x, y;
  if (portrait) {
    // Phone held vertically: the sensor frame is rotated -90 deg from
    // the world frame. What MediaPipe calls "yaw" is roll in the user
    // frame, and vice versa.
    yaw   = -e.roll;
    pitch =  e.pitch;
    roll  =  e.yaw;
    x     =  ny;     // horizontal head motion shows up in the image's vertical axis
    y     = -nx;
  } else {
    yaw   = e.yaw;
    pitch = e.pitch;
    roll  = e.roll;
    x     = nx;
    y     = ny;
  }

  const raw = { yaw, pitch, roll, x, y, z: tz };
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
  // Distance compensation for translations: when the user is closer to
  // the camera than at calibration time, the same real movement produces
  // larger raw X/Y values (perspective). We rescale X and Y by the ratio
  // |Zref| / |Zcurrent| so the sensitivity stays consistent regardless
  // of distance. Z is left untouched (it is already a real distance).
  const zRef = Math.abs(c.z) || 50;
  const zNow = Math.abs(pose.z) || zRef;
  const distScale = zNow / zRef;
  ce.x *= distScale;
  ce.y *= distScale;
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

// ----- Gizmo rendering ---------------------------------------------------

// Project a model-space 3D point through the matrix and a simple
// orthographic-with-bias camera, returning 2D pixel coordinates inside
// the canvas of size (w, h). The point order in the returned array is
// origin, X tip, Y tip, Z tip.
function projectAxes(matrix, w, h) {
  const TIP = 4; // unit length scaled to be visible
  const points = [
    [0, 0, 0],
    [TIP, 0, 0],
    [0, TIP, 0],
    [0, 0, TIP],
  ];
  const tx = matrix[12], ty = matrix[13], tz = matrix[14];
  // Use the average translation as anchor in screen space.
  // Since the rear camera flips x and yaw, we mirror x for display.
  const cx = w * 0.5;
  const cy = h * 0.5;
  // crude depth-aware scale: closer face = bigger axes
  const depthScale = Math.max(0.5, Math.min(2.5, 30 / Math.max(8, Math.abs(tz) + 8)));
  const projected = [];
  for (const [px, py, pz] of points) {
    const X = matrix[0] * px + matrix[4] * py + matrix[8]  * pz + tx;
    const Y = matrix[1] * px + matrix[5] * py + matrix[9]  * pz + ty;
    // We do not need Z for the 2D draw.
    projected.push([cx + X * 6 * depthScale, cy - Y * 6 * depthScale]);
  }
  return projected;
}

// One DrawingUtils per canvas, lazily created (it caches the 2D context).
const drawingUtilsByCtx = new WeakMap();
function getDrawingUtils(ctx) {
  let du = drawingUtilsByCtx.get(ctx);
  if (!du) {
    du = new DrawingUtils(ctx);
    drawingUtilsByCtx.set(ctx, du);
  }
  return du;
}

function drawGizmo(ctx, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (!lastLandmarks) return;
  const w = targetWidth, h = targetHeight;
  ctx.save();
  // DrawingUtils projects normalized landmarks onto the current canvas size,
  // so we just need to make sure the context's transform is identity.
  const du = getDrawingUtils(ctx);
  // Tesselation: full face mesh, thin and translucent.
  du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION,
    { color: "rgba(255,255,255,0.25)", lineWidth: 1 });
  // Feature contours: thicker and colored.
  du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
    { color: "#22c55e", lineWidth: 2 });
  du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
    { color: "#3b82f6", lineWidth: 2 });
  du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
    { color: "#3b82f6", lineWidth: 2 });
  du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
    { color: "#a855f7", lineWidth: 2 });
  du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
    { color: "#a855f7", lineWidth: 2 });
  du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_LIPS,
    { color: "#f43f5e", lineWidth: 2 });
  if (FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS) {
    du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
      { color: "#fbbf24", lineWidth: 2 });
    du.drawConnectors(lastLandmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
      { color: "#fbbf24", lineWidth: 2 });
  }
  // Axes from the facial transformation matrix.
  if (lastMatrix) {
    const [o, xT, yT, zT] = projectAxes(lastMatrix, w, h);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const drawAxis = (tip, color) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(o[0], o[1]);
      ctx.lineTo(tip[0], tip[1]);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(tip[0], tip[1], 4, 0, Math.PI * 2);
      ctx.fill();
    };
    drawAxis(xT, "#ef4444"); // X red
    drawAxis(yT, "#22c55e"); // Y green
    drawAxis(zT, "#3b82f6"); // Z blue
  }
  ctx.restore();
}

// Render a frame to the broadcast canvas: video + (optional) gizmo.
// We do NOT rotate the source: whatever the camera streams is shipped
// as-is. The PC preview already adapts its aspect ratio to the actual
// videoWidth/videoHeight, so we only need to keep the canvas in sync
// with the source.
function renderBroadcastFrame() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw) return;
  const target = 720;
  let cw, ch;
  if (vw >= vh) { cw = target; ch = Math.round(target * vh / vw); }
  else          { ch = target; cw = Math.round(target * vw / vh); }
  if (broadcastCanvas.width !== cw || broadcastCanvas.height !== ch) {
    broadcastCanvas.width = cw;
    broadcastCanvas.height = ch;
  }
  broadcastCtx.drawImage(els.video, 0, 0, cw, ch);
  if (state.gizmoEnabled) {
    drawGizmo(broadcastCtx, vw, vh, cw, ch);
  }
}

// Render the on-phone gizmo overlay (matches the visible video element).
function renderPhoneGizmo() {
  const w = els.gizmo.clientWidth, h = els.gizmo.clientHeight;
  if (els.gizmo.width !== w || els.gizmo.height !== h) {
    els.gizmo.width = w; els.gizmo.height = h;
  }
  gizmoCtx.clearRect(0, 0, w, h);
  if (state.gizmoEnabled) {
    drawGizmo(gizmoCtx, els.video.videoWidth, els.video.videoHeight, w, h);
  }
}

// Broadcast a status snapshot to the PC so it can mirror the overlay
// and surface diagnostic info (calibration ranges, bypass state...).
let lastStatusAt = 0;
function maybeSendStatus(now) {
  if (now - lastStatusAt < 100) return;
  lastStatusAt = now;
  const payload = {
    type: "phoneStatus",
    mode: state.mode,
    bypass: state.bypass,
    calibration: state.calibration,
  };
  if (state.mode === "countdown") {
    const total = state.countdownTotalMs || 10000;
    const remaining = Math.max(0, state.countdownEndAt - now);
    payload.countdown = {
      seconds: Math.ceil(remaining / 1000),
      ratio: total > 0 ? 1 - remaining / total : 1,
    };
  } else if (state.mode === "calibrating") {
    const step = STEPS[state.calStepIdx];
    const elapsed = now - state.calStepStart;
    payload.calibration = {
      stepIndex: state.calStepIdx,
      stepCount: STEPS.length,
      arrow: step.arrow,
      title: step.title,
      sub: step.sub,
      seconds: Math.ceil(Math.max(0, step.duration - elapsed) / 1000),
      ratio: Math.min(1, elapsed / step.duration),
    };
  }
  send(payload);
}

// ----- Calibration wizard (driven by PC, displayed on phone) ------------

const STEPS = [
  { axis: null,    sign: 0,  arrow: "·",  title: "Regarde droit devant",          sub: "Reste centré et immobile.",                    duration: 3000 },
  { axis: "yaw",   sign: -1, arrow: "←",  title: "Tourne la tête à fond à gauche", sub: "Sans bouger les épaules.",                    duration: 5000 },
  { axis: "yaw",   sign: +1, arrow: "→",  title: "Tourne la tête à fond à droite", sub: "Sans bouger les épaules.",                    duration: 5000 },
  { axis: "pitch", sign: +1, arrow: "↑",  title: "Regarde en haut",                sub: "Lève la tête au max confortable.",            duration: 5000 },
  { axis: "pitch", sign: -1, arrow: "↓",  title: "Regarde en bas",                 sub: "Baisse la tête au max confortable.",          duration: 5000 },
  { axis: "roll",  sign: -1, arrow: "↶",  title: "Penche la tête sur l'épaule gauche", sub: "Tête seule, oreille vers l'épaule.",      duration: 5000 },
  { axis: "roll",  sign: +1, arrow: "↷",  title: "Penche la tête sur l'épaule droite", sub: "Tête seule, oreille vers l'épaule.",      duration: 5000 },
  { axis: "x",     sign: -1, arrow: "↤",  title: "Glisse la tête à gauche",        sub: "Translation latérale, ne penche pas.",        duration: 5000 },
  { axis: "x",     sign: +1, arrow: "↦",  title: "Glisse la tête à droite",        sub: "Translation latérale, ne penche pas.",        duration: 5000 },
  { axis: "y",     sign: +1, arrow: "⇡",  title: "Lève la tête (allonge le cou)",  sub: "Le visage monte, ne pas pencher.",            duration: 5000 },
  { axis: "y",     sign: -1, arrow: "⇣",  title: "Baisse la tête (rentre le cou)", sub: "Le visage descend, ne pas pencher.",          duration: 5000 },
  { axis: "z",     sign: +1, arrow: "⊕",  title: "Approche la tête",               sub: "Avance vers la caméra.",                       duration: 5000 },
  { axis: "z",     sign: -1, arrow: "⊖",  title: "Recule la tête",                 sub: "Recule par rapport à la caméra.",              duration: 5000 },
];

function startCountdown(seconds) {
  if (!state.cameraReady || !state.modelReady) return;
  state.mode = "countdown";
  state.countdownTotalMs = seconds * 1000;
  state.countdownEndAt = performance.now() + state.countdownTotalMs;
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
    maybeSendStatus(now);
    const result = state.landmarker.detectForVideo(els.video, now);
    const matrices = result.facialTransformationMatrixes;
    lastLandmarks = result.faceLandmarks?.[0] ?? null;
    lastMatrix = matrices?.[0]?.data ?? null;
    renderBroadcastFrame();
    renderPhoneGizmo();
    if (matrices && matrices.length > 0) {
      const raw = computePose(matrices[0].data, lastLandmarks);
      state.lastRaw = raw;
      // First-run bootstrap (or partial restore): make sure every axis
      // has a center value and a sane range. If the calibration object
      // exists but some keys are missing (e.g. after a partial manual
      // edit from the tuner), fill in the gaps.
      if (!state.calibration.center) state.calibration.center = {};
      if (!state.calibration.ranges) state.calibration.ranges = {};
      for (const k of RAW_KEYS) {
        if (state.calibration.center[k] == null) {
          state.calibration.center[k] = raw[k];
        }
        if (!state.calibration.ranges[k]) {
          state.calibration.ranges[k] = { ...FALLBACK[k] };
        }
      }

      // Debug recording: send a snapshot every frame to the connector
      // so it can dump a JSON file. Includes the raw 4x4 matrix, the
      // pose extracted by computePose, and the latest center.
      if (state.debugRecording) {
        if (now >= state.debugRecordingEndAt) {
          state.debugRecording = false;
          send({ type: "debugRecordingEnd" });
        } else {
          send({
            type: "debugFrame",
            t: now,
            matrix: Array.from(matrices[0].data),
            raw,
            mode: state.mode,
            bypass: state.bypass,
            center: state.calibration.center,
          });
        }
      }

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
        // Debug recording: also enabled outside of "active" only when paired
        // with calibration/bypass capture, but for now we keep it tied to
        // active so we record what is actually sent to OpenTrack.
        let out;
        if (state.bypass) {
          // Bypass: still subtract an auto-captured center so the
          // values are deltas around 0 (raw MediaPipe translations are
          // in canonical-face units centered around ~50cm-from-camera,
          // which would otherwise saturate). The center is captured
          // the first frame after enabling bypass and discarded when
          // bypass is turned off.
          if (!state.bypassCenter) state.bypassCenter = { ...raw };
          const c = state.bypassCenter;
          out = {
            yaw:   (raw.yaw   - c.yaw)   * BYPASS_DEG_GAIN,
            pitch: (raw.pitch - c.pitch) * BYPASS_DEG_GAIN,
            roll:  (raw.roll  - c.roll)  * BYPASS_DEG_GAIN,
            x:     (raw.x     - c.x)     * BYPASS_TR_GAIN,
            y:     (raw.y     - c.y)     * BYPASS_TR_GAIN,
            z:     (raw.z     - c.z)     * BYPASS_TR_GAIN,
          };
        } else {
          state.bypassCenter = null;
          out = applyCenterAndScale(raw);
        }
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
          sendPose(filtered);
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
