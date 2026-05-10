"use strict";

const AXES = [
  { key: "yaw",   label: "Yaw",   sub: "rotation gauche / droite", unit: "°",  gainMax: 5 },
  { key: "pitch", label: "Pitch", sub: "rotation haut / bas",      unit: "°",  gainMax: 5 },
  { key: "roll",  label: "Roll",  sub: "tête sur l'épaule",        unit: "°",  gainMax: 3 },
  { key: "x",     label: "X",     sub: "translation latérale",     unit: "cm", gainMax: 5 },
  { key: "y",     label: "Y",     sub: "translation verticale",    unit: "cm", gainMax: 5 },
  { key: "z",     label: "Z",     sub: "translation avant / arrière", unit: "cm", gainMax: 5 },
];

const FIELDS_BOOL = ["enabled", "invert"];
const FIELDS_NUM  = ["gain", "expo", "offset", "deadzone"];

const els = {
  rows: document.getElementById("rows"),
  dot: document.getElementById("dot"),
  relayStatus: document.getElementById("relay-status"),
  phoneStatus: document.getElementById("phone-status"),
  rate: document.getElementById("rate"),
  reset: document.getElementById("reset"),
  start: document.getElementById("start"),
  pauseResume: document.getElementById("pauseResume"),
  recenter: document.getElementById("recenter"),
  calibrate: document.getElementById("calibrate"),
  startDelay: document.getElementById("startDelay"),
  rtcVideo: document.getElementById("rtcVideo"),
  rtcOverlay: document.getElementById("rtcOverlay"),
  rtcToggle: document.getElementById("rtcToggle"),
  gizmoToggle: document.getElementById("gizmoToggle"),
  rtcStatus: document.getElementById("rtcStatus"),
  phoneOverlay: document.getElementById("phoneOverlay"),
  poStep: document.getElementById("po-step"),
  poArrow: document.getElementById("po-arrow"),
  poTitle: document.getElementById("po-title"),
  poSub: document.getElementById("po-sub"),
  poNum: document.getElementById("po-num"),
  poRing: document.getElementById("po-ring"),
  resetCal: document.getElementById("resetCal"),
  bypass: document.getElementById("bypass"),
  calDiag: document.getElementById("calDiag"),
  debugRecord: document.getElementById("debugRecord"),
  debugStatus: document.getElementById("debugStatus"),
  gazeEnabled: document.getElementById("gazeEnabled"),
  gazeCalibrate: document.getElementById("gazeCalibrate"),
  gazeReset: document.getElementById("gazeReset"),
  gazeSensX: document.getElementById("gazeSensX"),
  gazeSensY: document.getElementById("gazeSensY"),
  gazeDeadzone: document.getElementById("gazeDeadzone"),
  gazeSmoothing: document.getElementById("gazeSmoothing"),
  gazeSensXVal: document.getElementById("gazeSensXVal"),
  gazeSensYVal: document.getElementById("gazeSensYVal"),
  gazeDeadzoneVal: document.getElementById("gazeDeadzoneVal"),
  gazeSmoothingVal: document.getElementById("gazeSmoothingVal"),
  gazeLive: document.getElementById("gazeLive"),
  gazeCalOverlay: document.getElementById("gazeCalOverlay"),
  gazeCalTitle: document.getElementById("gazeCalTitle"),
  gazeCalSub: document.getElementById("gazeCalSub"),
  gazeCalNum: document.getElementById("gazeCalNum"),
  gazeCalCancel: document.getElementById("gazeCalCancel"),
  gazeCalStep: document.getElementById("gazeCalStep"),
  cameraPosition: document.getElementById("cameraPosition"),
  gazeHeadFallback: document.getElementById("gazeHeadFallback"),
  gazeStats: document.getElementById("gazeStats"),
};

const PO_CIRC = 2 * Math.PI * 46;

const state = {
  ws: null,
  settings: null,
  paused: false,
  phoneConnected: false,
  relayConnected: false,
  lastPackets: 0,
  lastTs: performance.now(),
  pc: null,
  rtcWanted: false,
  lastGazeCal: null, // populated after each calibration
};

// ----- Settings rows -----------------------------------------------------

function buildRow(axis) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.axis = axis.key;
  row.innerHTML = `
    <div class="name">${axis.label}<small>${axis.sub}</small></div>
    <div class="cell-ctl" data-label="Activé"><input type="checkbox" data-field="enabled"></div>
    <div class="cell-ctl" data-label="Inverser"><input type="checkbox" data-field="invert"></div>
    <div class="cell-ctl" data-label="Gain">
      <input type="range" data-field="gain" min="0" max="${axis.gainMax}" step="0.05" />
      <input type="number" data-field="gain" min="0" max="20" step="0.05" />
    </div>
    <div class="cell-ctl" data-label="Expo">
      <input type="range" data-field="expo" min="0.5" max="3" step="0.05" />
      <input type="number" data-field="expo" min="0.5" max="5" step="0.05" />
    </div>
    <div class="cell-ctl" data-label="Offset">
      <input type="range" data-field="offset" min="-30" max="30" step="0.1" />
      <input type="number" data-field="offset" min="-180" max="180" step="0.1" />
    </div>
    <div class="cell-ctl" data-label="Zone morte">
      <input type="range" data-field="deadzone" min="0" max="5" step="0.05" />
      <input type="number" data-field="deadzone" min="0" max="30" step="0.05" />
    </div>
    <div class="cell-val in"  data-axis="${axis.key}" data-kind="in">—</div>
    <div class="cell-val out" data-axis="${axis.key}" data-kind="out">—</div>
  `;
  els.rows.appendChild(row);
  return row;
}

function applyToInputs(row, conf) {
  for (const f of FIELDS_BOOL) {
    row.querySelectorAll(`[data-field="${f}"]`).forEach((el) => { el.checked = !!conf[f]; });
  }
  for (const f of FIELDS_NUM) {
    row.querySelectorAll(`[data-field="${f}"]`).forEach((el) => { if (conf[f] != null) el.value = conf[f]; });
  }
}

function readFromRow(row) {
  const get = (f) => row.querySelector(`input[data-field="${f}"]`);
  const num = (f) => parseFloat(row.querySelector(`input[type="number"][data-field="${f}"]`).value);
  return {
    enabled: get("enabled").checked,
    invert: get("invert").checked,
    gain: num("gain"),
    expo: num("expo"),
    offset: num("offset"),
    deadzone: num("deadzone"),
  };
}

function pushSettings() {
  fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state.settings),
  });
}

function bindRow(row, axisKey) {
  row.addEventListener("input", (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    const partners = row.querySelectorAll(`[data-field="${field}"]`);
    for (const p of partners) if (p !== e.target && (p.type === "range" || p.type === "number")) p.value = e.target.value;
    state.settings[axisKey] = readFromRow(row);
    pushSettings();
  });
}

function build() {
  els.rows.innerHTML = "";
  for (const a of AXES) {
    const row = buildRow(a);
    bindRow(row, a.key);
    if (state.settings?.[a.key]) applyToInputs(row, state.settings[a.key]);
  }
}

// ----- Live updates ------------------------------------------------------

function refreshButtons() {
  const ready = state.phoneConnected;
  els.start.disabled = !ready;
  els.pauseResume.disabled = !ready;
  els.recenter.disabled = !ready;
  els.calibrate.disabled = !ready;
  els.rtcToggle.disabled = !ready;
  els.gizmoToggle.disabled = !ready;
  els.resetCal.disabled = !ready;
  els.bypass.disabled = !ready;
  els.debugRecord.disabled = !ready;
}

function updateLive(live) {
  els.dot.classList.toggle("ok", !!live.relayConnected);
  state.relayConnected = !!live.relayConnected;
  els.relayStatus.textContent = state.relayConnected ? "relay : connecté" : "relay : déconnecté";
  state.phoneConnected = !!live.phoneConnected;
  els.phoneStatus.textContent = state.phoneConnected ? "téléphone : connecté" : "téléphone : absent";
  refreshButtons();

  const now = performance.now();
  const dt = (now - state.lastTs) / 1000;
  if (dt >= 0.5) {
    const rate = Math.round((live.packets - state.lastPackets) / dt);
    els.rate.textContent = `${rate} paquets/s`;
    state.lastPackets = live.packets;
    state.lastTs = now;
  }

  for (const a of AXES) {
    const inEl  = document.querySelector(`.cell-val[data-axis="${a.key}"][data-kind="in"]`);
    const outEl = document.querySelector(`.cell-val[data-axis="${a.key}"][data-kind="out"]`);
    if (inEl)  inEl.textContent  = live.in  ? `${live.in[a.key].toFixed(2)} ${a.unit}` : "—";
    if (outEl) outEl.textContent = live.out ? `${live.out[a.key].toFixed(2)} ${a.unit}` : "—";
  }
}

// ----- WebRTC preview ----------------------------------------------------

function setRtcStatus(text) { els.rtcStatus.textContent = text; }

function rtcSendSignal(payload) {
  if (state.ws?.readyState === 1) {
    state.ws.send(JSON.stringify({ type: "rtc", payload }));
  }
}

async function startPreview() {
  if (state.pc) return;
  state.rtcWanted = true;
  setRtcStatus("connexion…");
  els.rtcToggle.textContent = "Désactiver l'aperçu";
  // Ask the phone to start sending its track.
  rtcSendSignal({ kind: "request" });
}

function stopPreview() {
  state.rtcWanted = false;
  if (state.pc) { try { state.pc.close(); } catch {} state.pc = null; }
  els.rtcVideo.srcObject = null;
  els.rtcOverlay.classList.remove("hidden");
  els.rtcOverlay.textContent = "Aperçu désactivé";
  setRtcStatus("inactif");
  els.rtcToggle.textContent = "Activer l'aperçu";
  rtcSendSignal({ kind: "stop" });
}

async function ensurePeer() {
  if (state.pc) return state.pc;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  state.pc = pc;
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    els.rtcVideo.srcObject = stream;
    els.rtcOverlay.classList.add("hidden");
    setRtcStatus("aperçu en cours");
    // Toggle .landscape on the preview-stage based on the actual
    // stream orientation. CSS handles the sizing from there.
    const updateRatio = () => {
      const w = els.rtcVideo.videoWidth, h = els.rtcVideo.videoHeight;
      if (w > 0 && h > 0) {
        const stage = els.rtcVideo.parentElement;
        stage.classList.toggle("landscape", w > h);
      }
    };
    els.rtcVideo.addEventListener("loadedmetadata", updateRatio);
    els.rtcVideo.addEventListener("resize", updateRatio);
    updateRatio();
  };
  pc.onicecandidate = (e) => { if (e.candidate) rtcSendSignal({ kind: "ice", candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    setRtcStatus(`webrtc : ${pc.connectionState}`);
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      stopPreview();
    }
  };
  return pc;
}

async function handleRtcSignal(payload) {
  if (!payload) return;
  if (payload.kind === "phoneGone") {
    stopPreview();
    return;
  }
  if (payload.kind === "offer") {
    const pc = await ensurePeer();
    await pc.setRemoteDescription(payload.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    rtcSendSignal({ kind: "answer", sdp: pc.localDescription });
    return;
  }
  if (payload.kind === "ice" && state.pc && payload.candidate) {
    try { await state.pc.addIceCandidate(payload.candidate); } catch {}
  }
}

// ----- Phone overlay (mirrors what the phone is showing) ---------------

function renderPhoneOverlay(p) {
  if (!p || !p.mode || (p.mode !== "countdown" && p.mode !== "calibrating")) {
    els.phoneOverlay.classList.add("hidden");
    return;
  }
  els.phoneOverlay.classList.remove("hidden");
  if (p.mode === "countdown" && p.countdown) {
    els.poStep.textContent = "Démarrage";
    els.poArrow.textContent = "";
    els.poTitle.textContent = "Place le téléphone derrière toi";
    els.poSub.textContent = "Le tracking commence dans…";
    els.poNum.textContent = String(p.countdown.seconds);
    els.poRing.style.strokeDashoffset = String(PO_CIRC * (1 - Math.min(1, Math.max(0, p.countdown.ratio))));
    return;
  }
  if (p.mode === "calibrating" && p.calibration) {
    const c = p.calibration;
    els.poStep.textContent = `Étape ${c.stepIndex + 1} / ${c.stepCount}`;
    els.poArrow.textContent = c.arrow || "";
    els.poTitle.textContent = c.title || "";
    els.poSub.textContent = c.sub || "";
    els.poNum.textContent = String(c.seconds);
    els.poRing.style.strokeDashoffset = String(PO_CIRC * (1 - Math.min(1, Math.max(0, c.ratio))));
  }
}

// ----- Calibration diagnostics -----------------------------------------

const RAW_AXES = ["yaw", "pitch", "roll", "x", "y", "z"];
const RAW_LABELS = { yaw: "Yaw", pitch: "Pitch", roll: "Roll", x: "X", y: "Y", z: "Z" };
const RAW_UNITS  = { yaw: "rad", pitch: "rad", roll: "rad", x: "u", y: "u", z: "u" };
// Heuristic: a healthy calibrated range should be well above this in raw units.
const MIN_HEALTHY_SPAN = { yaw: 0.15, pitch: 0.10, roll: 0.10, x: 1.0, y: 1.0, z: 1.0 };

let calTableBuilt = false;

function ensureCalTable() {
  if (calTableBuilt) return;
  let html = '<table><thead><tr><th>Axe</th><th>Centre</th><th>Min</th><th>Max</th><th>Amplitude</th><th>État</th></tr></thead><tbody>';
  for (const k of RAW_AXES) {
    html += `<tr data-axis="${k}">
      <td class="axis">${RAW_LABELS[k]}</td>
      <td><input class="cal-edit" data-field="center" type="number" step="0.01" /></td>
      <td><input class="cal-edit" data-field="min"    type="number" step="0.01" /></td>
      <td><input class="cal-edit" data-field="max"    type="number" step="0.01" /></td>
      <td class="span"></td>
      <td class="status"></td>
    </tr>`;
  }
  html += '</tbody></table><div class="muted small" style="margin-top:8px">Astuce : tape une nouvelle valeur dans une cellule pour ajuster la calibration en direct, sans relancer le wizard.</div>';
  els.calDiag.innerHTML = html;
  // Wire input -> command
  els.calDiag.querySelectorAll('input.cal-edit').forEach((inp) => {
    // Disable mouse-wheel changes on these inputs: too easy to bump a
    // value by 10x or 100x by accident while scrolling the page.
    inp.addEventListener('wheel', (e) => { if (document.activeElement === inp) e.preventDefault(); }, { passive: false });
    inp.addEventListener('change', () => {
      const tr = inp.closest('tr');
      const k = tr.dataset.axis;
      const field = inp.dataset.field;
      const v = parseFloat(inp.value);
      if (Number.isNaN(v)) return;
      // Sanity check: if the value is more than 50x what's typical for
      // this axis, ask the user to confirm. Avoids accidental scroll-
      // wheel ten-folding (e.g. typing -210 instead of -21).
      const typical = (RAW_UNITS[k] === 'rad') ? 2 : 50;
      if (Math.abs(v) > typical) {
        const ok = confirm(`Valeur inhabituelle (${v}) pour ${RAW_LABELS[k]} ${field}. Confirmer ?`);
        if (!ok) {
          // Revert visually; the next phoneStatus tick will restore the real value.
          inp.blur();
          return;
        }
      }
      const partial = { ranges: {} };
      if (field === 'center') {
        partial.center = {};
        partial.center[k] = v;
      } else {
        partial.ranges[k] = {};
        partial.ranges[k][field] = v;
      }
      sendCommand({ type: 'setCalibration', calibration: partial });
    });
  });
  calTableBuilt = true;
}

function renderCalDiag(phone) {
  const cal = phone?.calibration;
  if (!cal || !cal.ranges) {
    if (calTableBuilt) {
      els.calDiag.querySelectorAll('input.cal-edit').forEach((i) => { if (document.activeElement !== i) i.value = ''; });
    } else {
      els.calDiag.innerHTML = '<div class="muted">aucune calibration en mémoire</div>';
    }
    return;
  }
  ensureCalTable();
  for (const k of RAW_AXES) {
    const r = cal.ranges[k] || { min: 0, max: 0 };
    const c = cal.center?.[k];
    const span = (r.max || 0) - (r.min || 0);
    const min = MIN_HEALTHY_SPAN[k] || 0;
    let cls = "";
    let label = "OK";
    if (span <= 0) { cls = "bad"; label = "non calibré"; }
    else if (span < min) { cls = "warn"; label = "amplitude faible"; }
    const tr = els.calDiag.querySelector(`tr[data-axis="${k}"]`);
    if (!tr) continue;
    const inputs = {
      center: tr.querySelector('input[data-field="center"]'),
      min:    tr.querySelector('input[data-field="min"]'),
      max:    tr.querySelector('input[data-field="max"]'),
    };
    // Don't overwrite a cell the user is currently editing.
    if (document.activeElement !== inputs.center) inputs.center.value = c == null ? '' : c.toFixed(3);
    if (document.activeElement !== inputs.min)    inputs.min.value    = (r.min || 0).toFixed(3);
    if (document.activeElement !== inputs.max)    inputs.max.value    = (r.max || 0).toFixed(3);
    tr.querySelector('.span').textContent = `${span.toFixed(3)} ${RAW_UNITS[k]}`;
    const statusCell = tr.querySelector('.status');
    statusCell.textContent = label;
    statusCell.className = `status ${cls}`;
  }
}

// ----- WS to local connector --------------------------------------------

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  state.ws = ws;
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data);
      if (msg.type === "settings") {
        state.settings = msg.settings;
        build();
        syncGazeUI();
      } else if (msg.type === "live") {
        updateLive(msg);
      } else if (msg.type === "rtc") {
        handleRtcSignal(msg.payload);
      } else if (msg.type === "calibrationDone") {
        setRtcStatus(state.pc ? "aperçu en cours" : "inactif");
        renderPhoneOverlay({ mode: "active" });
      } else if (msg.type === "calibrationUpdated") {
        // Phone ack after a manual edit. If anything was rejected,
        // log it to the console for the curious; the auto-repair means
        // the UI already shows the corrected value on the next status tick.
        if (Array.isArray(msg.rejected) && msg.rejected.length > 0) {
          console.warn("[tuner] calibration values rejected:", msg.rejected.join(", "));
        }
      } else if (msg.type === "phoneStatus") {
        renderPhoneOverlay(msg.phone || {});
        renderCalDiag(msg.phone || {});
        if (msg.phone && typeof msg.phone.bypass === "boolean") {
          els.bypass.checked = msg.phone.bypass;
        }
        if (msg.phone && typeof msg.phone.gizmoEnabled === "boolean" && msg.phone.gizmoEnabled !== gizmoOn) {
          gizmoOn = msg.phone.gizmoEnabled;
          setGizmoButtonLabel();
        }
        if (msg.phone && typeof msg.phone.cameraPosition === "string" &&
            els.cameraPosition && document.activeElement !== els.cameraPosition &&
            els.cameraPosition.value !== msg.phone.cameraPosition) {
          els.cameraPosition.value = msg.phone.cameraPosition;
        }
        if (msg.phone && typeof msg.phone.gazeHeadFallback === "boolean" &&
            els.gazeHeadFallback && els.gazeHeadFallback.checked !== msg.phone.gazeHeadFallback) {
          els.gazeHeadFallback.checked = msg.phone.gazeHeadFallback;
        }
        // Live gaze indicator + sample collection during gaze calibration.
        if (msg.phone) {
          const gr = msg.phone.lastGazeRaw;
          const g = msg.phone.lastGaze;
          if (g && Number.isFinite(g.x) && Number.isFinite(g.y)) {
            els.gazeLive.textContent = `x=${g.x.toFixed(2)}  y=${g.y.toFixed(2)}  (raw x=${gr?.x?.toFixed?.(2) ?? "?"}  y=${gr?.y?.toFixed?.(2) ?? "?"})`;
          }
          if (gazeCal.running && gr && Number.isFinite(gr.x) && Number.isFinite(gr.y) &&
              Number.isFinite(gr.yaw) && Number.isFinite(gr.pitch)) {
            // Skip the first GAZE_SETTLE_MS of each point so the eyes
            // can move to it before we sample. Index 0..15 = the dot
            // currently active in the 4x4 grid.
            if (performance.now() - gazeCal.startedAt > GAZE_SETTLE_MS) {
              gazeCal.samples[gazeCal.idx].push(gr);
            }
          }
        }
      } else if (msg.type === "debug") {
        if (msg.phase === "start") {
          els.debugStatus.textContent = "enregistrement en cours…";
          els.debugRecord.disabled = true;
        } else if (msg.phase === "end") {
          els.debugStatus.textContent = `${msg.frames} frames → ${msg.path}`;
          els.debugRecord.disabled = false;
        } else if (msg.phase === "error") {
          els.debugStatus.textContent = `erreur : ${msg.message}`;
          els.debugRecord.disabled = false;
        }
      }
    } catch {}
  };
  ws.onclose = () => { state.ws = null; setTimeout(connectWS, 1000); };
}

// ----- Buttons -----------------------------------------------------------

function sendCommand(cmd) {
  return fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
}

els.reset.addEventListener("click", async () => {
  if (!confirm("Réinitialiser TOUS les réglages et la calibration ?\n\nCela remet les sliders aux defaults et efface la calibration sauvegardée sur le téléphone.")) return;
  // 1) Wipe connector-side settings (sliders, gains, expo, offsets...).
  const r = await fetch("/api/reset", { method: "POST" });
  state.settings = await r.json();
  build();
  // 2) Wipe the calibration stored on the phone too. Without this,
  // the user gets default sliders but is still riding a corrupted
  // calibration from a previous session.
  sendCommand({ type: "resetCalibration" });
});

els.start.addEventListener("click", () => {
  const delay = Math.max(0, Math.min(60, parseInt(els.startDelay.value, 10) || 0));
  els.start.textContent = `Démarrer (${delay} s)`;
  sendCommand({ type: "start", delay });
});
els.startDelay.addEventListener("input", () => {
  const delay = Math.max(0, Math.min(60, parseInt(els.startDelay.value, 10) || 0));
  els.start.textContent = `Démarrer (${delay} s)`;
});
els.pauseResume.addEventListener("click", () => {
  state.paused = !state.paused;
  els.pauseResume.textContent = state.paused ? "Reprendre" : "Pause";
  sendCommand({ type: state.paused ? "pause" : "resume" });
});
els.recenter.addEventListener("click", () => sendCommand({ type: "recenter" }));
els.calibrate.addEventListener("click", () => sendCommand({ type: "calibrate" }));
els.rtcToggle.addEventListener("click", () => {
  if (state.pc || state.rtcWanted) stopPreview(); else startPreview();
});

let gizmoOn = true;
function setGizmoButtonLabel() {
  els.gizmoToggle.textContent = gizmoOn ? "Masquer le gizmo" : "Afficher le gizmo";
}
els.gizmoToggle.addEventListener("click", () => {
  gizmoOn = !gizmoOn;
  setGizmoButtonLabel();
  sendCommand({ type: "setGizmo", enabled: gizmoOn });
});

els.resetCal.addEventListener("click", () => {
  if (!confirm("Effacer la calibration enregistrée sur le téléphone ?")) return;
  sendCommand({ type: "resetCalibration" });
});

els.bypass.addEventListener("change", () => {
  sendCommand({ type: "setBypass", enabled: els.bypass.checked });
});

els.debugRecord.addEventListener("click", () => {
  els.debugStatus.textContent = "démarrage…";
  sendCommand({ type: "startDebugRecording", duration: 5 });
});

// ----- Gaze (eye tracking) ---------------------------------------------

// 16-point grid (4 columns x 4 rows) covering the screen. Targets are
// expressed in [-1, +1] (-1 = left/top, +1 = right/bottom), the same
// space as the final gaze output the phone emits.
const GAZE_GRID = (() => {
  const pts = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      pts.push({
        // Map column/row index 0..3 to [-1, +1]: (i/3)*2 - 1
        targetX: (c / 3) * 2 - 1,
        targetY: (r / 3) * 2 - 1,
        // For CSS positioning inside .gaze-cal-grid (which has 40 px
        // inset on all sides): a percentage from 0 % to 100 %.
        cssX: (c / 3) * 100,
        cssY: (r / 3) * 100,
      });
    }
  }
  return pts;
})();
const GAZE_STEP_MS = 2000;
const GAZE_SETTLE_MS = 600;   // discard the first 600 ms of each point
const gazeCal = { running: false, idx: 0, startedAt: 0, samples: null, dotEls: [] };

function buildGazeCalGrid() {
  const grid = document.getElementById("gazeCalGrid");
  grid.innerHTML = "";
  gazeCal.dotEls = GAZE_GRID.map((p, i) => {
    const d = document.createElement("div");
    d.className = "gaze-cal-dot";
    d.style.left = p.cssX + "%";
    d.style.top  = p.cssY + "%";
    d.dataset.idx = String(i);
    grid.appendChild(d);
    return d;
  });
}

function syncGazeUI() {
  const g = state.settings?.gaze;
  if (!g) return;
  if (typeof g.enabled === "boolean" && els.gazeEnabled.checked !== g.enabled) els.gazeEnabled.checked = g.enabled;
  if (Number.isFinite(g.sensitivityX) && document.activeElement !== els.gazeSensX) els.gazeSensX.value = g.sensitivityX;
  if (Number.isFinite(g.sensitivityY) && document.activeElement !== els.gazeSensY) els.gazeSensY.value = g.sensitivityY;
  if (Number.isFinite(g.deadzone)     && document.activeElement !== els.gazeDeadzone)  els.gazeDeadzone.value = g.deadzone;
  if (Number.isFinite(g.smoothing)    && document.activeElement !== els.gazeSmoothing) els.gazeSmoothing.value = g.smoothing;
  updateGazeSliderLabels();
}

function updateGazeSliderLabels() {
  els.gazeSensXVal.textContent = parseFloat(els.gazeSensX.value).toFixed(2);
  els.gazeSensYVal.textContent = parseFloat(els.gazeSensY.value).toFixed(2);
  els.gazeDeadzoneVal.textContent = parseFloat(els.gazeDeadzone.value).toFixed(2);
  els.gazeSmoothingVal.textContent = parseFloat(els.gazeSmoothing.value).toFixed(2);
}

function pushGazeSettings() {
  if (!state.settings) return;
  state.settings.gaze = state.settings.gaze || {};
  state.settings.gaze.enabled = els.gazeEnabled.checked;
  state.settings.gaze.sensitivityX = parseFloat(els.gazeSensX.value);
  state.settings.gaze.sensitivityY = parseFloat(els.gazeSensY.value);
  state.settings.gaze.deadzone = parseFloat(els.gazeDeadzone.value);
  state.settings.gaze.smoothing = parseFloat(els.gazeSmoothing.value);
  pushSettings();
  updateGazeSliderLabels();
}

[els.gazeSensX, els.gazeSensY, els.gazeDeadzone, els.gazeSmoothing].forEach((el) => {
  el.addEventListener("input", pushGazeSettings);
});
els.gazeEnabled.addEventListener("change", pushGazeSettings);

els.gazeReset.addEventListener("click", () => {
  if (!confirm("Effacer la calibration regard ?")) return;
  sendCommand({ type: "resetGazeCalibration" });
});

function highlightGazeDot(idx) {
  for (let i = 0; i < gazeCal.dotEls.length; i++) {
    const d = gazeCal.dotEls[i];
    d.classList.remove("active");
    if (i === idx) d.classList.add("active");
    else if (idx != null && i < idx) d.classList.add("done");
  }
}

function startGazeCalibration() {
  if (gazeCal.running) return;
  if (!state.phoneConnected) {
    alert("Le téléphone doit être connecté pour calibrer le regard.");
    return;
  }
  buildGazeCalGrid();
  gazeCal.running = true;
  gazeCal.idx = 0;
  gazeCal.startedAt = performance.now();
  gazeCal.samples = GAZE_GRID.map(() => []);
  els.gazeCalOverlay.classList.remove("hidden");
  refreshGazeCalUI();
  requestAnimationFrame(gazeCalibrationLoop);
}

function refreshGazeCalUI() {
  els.gazeCalStep.textContent = `Calibration regard — point ${gazeCal.idx + 1} / ${GAZE_GRID.length}`;
  els.gazeCalTitle.textContent = "Regarde le point bleu qui s'allume";
  els.gazeCalSub.textContent = "Garde la tête immobile. Suis uniquement avec les yeux.";
  els.gazeCalNum.textContent = Math.ceil(GAZE_STEP_MS / 1000);
  highlightGazeDot(gazeCal.idx);
}

function gazeCalibrationLoop() {
  if (!gazeCal.running) return;
  const now = performance.now();
  const elapsed = now - gazeCal.startedAt;
  els.gazeCalNum.textContent = Math.max(0, Math.ceil((GAZE_STEP_MS - elapsed) / 1000));
  if (elapsed >= GAZE_STEP_MS) {
    if (gazeCal.idx + 1 >= GAZE_GRID.length) {
      finalizeGazeCalibration();
      return;
    }
    gazeCal.idx++;
    gazeCal.startedAt = now;
    refreshGazeCalUI();
  }
  requestAnimationFrame(gazeCalibrationLoop);
}

function gazeCalibrationCancel() {
  gazeCal.running = false;
  els.gazeCalOverlay.classList.add("hidden");
}

// ----- Polynomial fit (least squares, normal equations) ---------------

function gazeFeatures(gx, gy, yaw, pitch) {
  return [
    1, gx, gy, yaw, pitch,
    gx * gy, gx * yaw, gx * pitch, gy * yaw, gy * pitch,
    yaw * pitch, gx * gx, gy * gy, yaw * yaw, pitch * pitch,
  ];
}

// Solve (X^T X) θ = X^T y for θ using Gauss elimination with partial
// pivoting. X is an n×p matrix and y a length-n vector. Returns the
// p-vector θ, or null if the system is singular.
function leastSquares(X, y) {
  const n = X.length, p = X[0].length;
  // Build A = X^T X (p×p) and b = X^T y (p)
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i], yi = y[i];
    for (let j = 0; j < p; j++) {
      b[j] += xi[j] * yi;
      const aj = A[j];
      for (let k = 0; k < p; k++) aj[k] += xi[j] * xi[k];
    }
  }
  // Add a tiny Tikhonov regularization on the diagonal to keep things
  // well-conditioned even when some features are nearly collinear.
  for (let i = 0; i < p; i++) A[i][i] += 1e-6;
  // Gauss elimination with partial pivoting on [A | b].
  for (let i = 0; i < p; i++) {
    let pivot = i;
    let maxAbs = Math.abs(A[i][i]);
    for (let r = i + 1; r < p; r++) {
      if (Math.abs(A[r][i]) > maxAbs) { maxAbs = Math.abs(A[r][i]); pivot = r; }
    }
    if (maxAbs < 1e-12) return null;
    if (pivot !== i) { [A[i], A[pivot]] = [A[pivot], A[i]]; [b[i], b[pivot]] = [b[pivot], b[i]]; }
    for (let r = i + 1; r < p; r++) {
      const factor = A[r][i] / A[i][i];
      for (let c = i; c < p; c++) A[r][c] -= factor * A[i][c];
      b[r] -= factor * b[i];
    }
  }
  // Back substitution.
  const theta = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < p; j++) s -= A[i][j] * theta[j];
    theta[i] = s / A[i][i];
  }
  return theta;
}

function finalizeGazeCalibration() {
  gazeCal.running = false;
  els.gazeCalOverlay.classList.add("hidden");
  // Build the design matrix and the two target vectors. For each
  // calibration point we use the median sample (robust to blinks).
  const median = (arr, k) => {
    const v = arr.map((p) => p[k]).filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : NaN;
  };
  const X = [], targetXs = [], targetYs = [];
  let usable = 0;
  for (let i = 0; i < GAZE_GRID.length; i++) {
    const samples = gazeCal.samples[i];
    if (!samples || samples.length < 3) continue;
    const gx = median(samples, "x");
    const gy = median(samples, "y");
    const yaw = median(samples, "yaw");
    const pitch = median(samples, "pitch");
    if (!Number.isFinite(gx) || !Number.isFinite(gy) ||
        !Number.isFinite(yaw) || !Number.isFinite(pitch)) continue;
    X.push(gazeFeatures(gx, gy, yaw, pitch));
    targetXs.push(GAZE_GRID[i].targetX);
    targetYs.push(GAZE_GRID[i].targetY);
    usable++;
  }
  if (usable < 12) {
    alert(`Calibration regard impossible : seulement ${usable} points exploitables sur ${GAZE_GRID.length}. Réessaie en gardant les yeux sur chaque point.`);
    return;
  }
  const coefX = leastSquares(X, targetXs);
  const coefY = leastSquares(X, targetYs);
  if (!coefX || !coefY) {
    alert("Calibration regard impossible : système numériquement singulier. Réessaie en bougeant un peu plus les yeux.");
    return;
  }
  // Quick residual sanity check: average error on the calibration
  // points themselves, in screen pixels (rough estimate).
  let rssX = 0, rssY = 0;
  for (let i = 0; i < X.length; i++) {
    let px = 0, py = 0;
    for (let j = 0; j < 15; j++) { px += coefX[j] * X[i][j]; py += coefY[j] * X[i][j]; }
    rssX += (px - targetXs[i]) ** 2;
    rssY += (py - targetYs[i]) ** 2;
  }
  const rmsX = Math.sqrt(rssX / X.length);
  const rmsY = Math.sqrt(rssY / X.length);
  const sampleCounts = gazeCal.samples.map((s) => s.length);
  console.log(`[gaze cal] ${usable} points, RMS error: x=${rmsX.toFixed(3)} y=${rmsY.toFixed(3)} (in [-1,+1] space)`);
  console.log(`[gaze cal] samples per point:`, sampleCounts);
  // Persist last calibration metrics so the user can see them in the UI.
  state.lastGazeCal = {
    rmsX, rmsY,
    usablePoints: usable,
    totalPoints: GAZE_GRID.length,
    samplesPerPoint: sampleCounts,
    timestamp: Date.now(),
  };
  renderGazeStats();
  sendCommand({
    type: "setGazeCalibration",
    calibration: { kind: "poly2", coefX, coefY },
  });
}

function renderGazeStats() {
  if (!els.gazeStats) return;
  const c = state.lastGazeCal;
  if (!c) {
    els.gazeStats.innerHTML = '<span class="muted">Aucune calibration enregistrée pendant cette session.</span>';
    return;
  }
  const qualityX = c.rmsX < 0.15 ? "ok" : c.rmsX < 0.30 ? "warn" : "bad";
  const qualityY = c.rmsY < 0.15 ? "ok" : c.rmsY < 0.30 ? "warn" : "bad";
  const samplesMin = Math.min(...c.samplesPerPoint);
  const samplesAvg = Math.round(c.samplesPerPoint.reduce((a, b) => a + b, 0) / c.samplesPerPoint.length);
  const ok = qualityX === "ok" && qualityY === "ok";
  els.gazeStats.innerHTML = `
    <div><b>Dernière calibration</b> (${c.usablePoints}/${c.totalPoints} points)</div>
    <div>RMS X = <span class="${qualityX}">${c.rmsX.toFixed(3)}</span> &middot; RMS Y = <span class="${qualityY}">${c.rmsY.toFixed(3)}</span></div>
    <div>Samples par point : min ${samplesMin}, moy ${samplesAvg}</div>
    <div class="muted small">Cible : RMS &lt; 0.15 (bon), &lt; 0.30 (moyen), au-dessus &rarr; refaire la calibration ou remonter le téléphone au niveau des yeux.</div>
    ${ok ? '' : '<div class="warn small">⚠ Calibration de qualité moyenne. Si la souris part en vrille, active le mode "Tête seule" ci-dessous.</div>'}
  `;
}

els.gazeCalibrate.addEventListener("click", startGazeCalibration);
els.gazeCalCancel.addEventListener("click", gazeCalibrationCancel);

if (els.cameraPosition) {
  els.cameraPosition.addEventListener("change", () => {
    sendCommand({ type: "setCameraPosition", position: els.cameraPosition.value });
  });
}

if (els.gazeHeadFallback) {
  els.gazeHeadFallback.addEventListener("change", () => {
    sendCommand({ type: "setGazeHeadFallback", enabled: els.gazeHeadFallback.checked });
  });
}

renderGazeStats();

updateGazeSliderLabels();

(async () => {
  const r = await fetch("/api/settings");
  state.settings = await r.json();
  build();
  syncGazeUI();
  connectWS();
})();
