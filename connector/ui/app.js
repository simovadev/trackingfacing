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
  rtcStatus: document.getElementById("rtcStatus"),
};

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
};

// ----- Settings rows -----------------------------------------------------

function buildRow(axis) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.axis = axis.key;
  row.innerHTML = `
    <div class="name">${axis.label}<small>${axis.sub}</small></div>
    <div class="cell-ctl"><input type="checkbox" data-field="enabled"></div>
    <div class="cell-ctl"><input type="checkbox" data-field="invert"></div>
    <div class="cell-ctl">
      <input type="range" data-field="gain" min="0" max="${axis.gainMax}" step="0.05" />
      <input type="number" data-field="gain" min="0" max="20" step="0.05" />
    </div>
    <div class="cell-ctl">
      <input type="range" data-field="expo" min="0.5" max="3" step="0.05" />
      <input type="number" data-field="expo" min="0.5" max="5" step="0.05" />
    </div>
    <div class="cell-ctl">
      <input type="range" data-field="offset" min="-30" max="30" step="0.1" />
      <input type="number" data-field="offset" min="-180" max="180" step="0.1" />
    </div>
    <div class="cell-ctl">
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
      } else if (msg.type === "live") {
        updateLive(msg);
      } else if (msg.type === "rtc") {
        handleRtcSignal(msg.payload);
      } else if (msg.type === "calibrationDone") {
        setRtcStatus(state.pc ? "aperçu en cours" : "inactif");
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
  if (!confirm("Réinitialiser tous les réglages aux valeurs par défaut ?")) return;
  const r = await fetch("/api/reset", { method: "POST" });
  state.settings = await r.json();
  build();
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

(async () => {
  const r = await fetch("/api/settings");
  state.settings = await r.json();
  build();
  connectWS();
})();
