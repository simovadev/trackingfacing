"use strict";

const AXES = [
  { key: "yaw",   label: "Yaw",   sub: "rotation gauche / droite", unit: "°",  gainMax: 5 },
  { key: "pitch", label: "Pitch", sub: "rotation haut / bas",      unit: "°",  gainMax: 5 },
  { key: "roll",  label: "Roll",  sub: "tête sur l'épaule",        unit: "°",  gainMax: 3 },
  { key: "x",     label: "X",     sub: "translation latérale",     unit: "cm", gainMax: 5 },
  { key: "y",     label: "Y",     sub: "translation verticale",    unit: "cm", gainMax: 5 },
  { key: "z",     label: "Z",     sub: "translation avant / arrière", unit: "cm", gainMax: 5 },
];

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
};

let paused = false;
let phoneConnected = false;

let settings = null;
let lastPackets = 0;
let lastTs = performance.now();

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
  for (const f of ["enabled", "invert"]) {
    row.querySelectorAll(`[data-field="${f}"]`).forEach((el) => { el.checked = !!conf[f]; });
  }
  for (const f of ["gain", "offset", "deadzone"]) {
    row.querySelectorAll(`[data-field="${f}"]`).forEach((el) => { el.value = conf[f]; });
  }
}

function readFromRow(row) {
  const get = (f) => row.querySelector(`input[data-field="${f}"]`);
  const num = (f) => parseFloat(row.querySelector(`input[type="number"][data-field="${f}"]`).value);
  return {
    enabled: get("enabled").checked,
    invert: get("invert").checked,
    gain: num("gain"),
    offset: num("offset"),
    deadzone: num("deadzone"),
  };
}

function pushSettings() {
  fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
}

function bindRow(row, axisKey) {
  row.addEventListener("input", (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    // Sync paired range/number for the same field.
    const partners = row.querySelectorAll(`[data-field="${field}"]`);
    for (const p of partners) if (p !== e.target && (p.type === "range" || p.type === "number")) p.value = e.target.value;
    settings[axisKey] = readFromRow(row);
    pushSettings();
  });
}

function build() {
  els.rows.innerHTML = "";
  for (const a of AXES) {
    const row = buildRow(a);
    bindRow(row, a.key);
    if (settings?.[a.key]) applyToInputs(row, settings[a.key]);
  }
}

function updateLive(live) {
  els.dot.classList.toggle("ok", !!live.relayConnected);
  els.relayStatus.textContent = live.relayConnected ? "relay : connecté" : "relay : déconnecté";
  phoneConnected = !!live.phoneConnected;
  els.phoneStatus.textContent = phoneConnected ? "téléphone : connecté" : "téléphone : absent";
  refreshButtons();

  const now = performance.now();
  const dt = (now - lastTs) / 1000;
  if (dt >= 0.5) {
    const rate = Math.round((live.packets - lastPackets) / dt);
    els.rate.textContent = `${rate} paquets/s`;
    lastPackets = live.packets;
    lastTs = now;
  }

  for (const a of AXES) {
    const inEl  = document.querySelector(`.cell-val[data-axis="${a.key}"][data-kind="in"]`);
    const outEl = document.querySelector(`.cell-val[data-axis="${a.key}"][data-kind="out"]`);
    if (inEl)  inEl.textContent  = live.in  ? `${live.in[a.key].toFixed(2)} ${a.unit}` : "—";
    if (outEl) outEl.textContent = live.out ? `${live.out[a.key].toFixed(2)} ${a.unit}` : "—";
  }
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data);
      if (msg.type === "settings") {
        settings = msg.settings;
        build();
      } else if (msg.type === "live") {
        updateLive(msg);
      }
    } catch {}
  };
  ws.onclose = () => setTimeout(connectWS, 1000);
}

els.reset.addEventListener("click", async () => {
  if (!confirm("Réinitialiser tous les réglages aux valeurs par défaut ?")) return;
  const r = await fetch("/api/reset", { method: "POST" });
  settings = await r.json();
  build();
});

function sendCommand(cmd) {
  return fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cmd),
  });
}

function refreshButtons() {
  const ready = phoneConnected;
  els.start.disabled = !ready;
  els.pauseResume.disabled = !ready;
  els.recenter.disabled = !ready;
  els.calibrate.disabled = !ready;
}

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
  paused = !paused;
  els.pauseResume.textContent = paused ? "Reprendre" : "Pause";
  sendCommand({ type: paused ? "pause" : "resume" });
});
els.recenter.addEventListener("click", () => sendCommand({ type: "recenter" }));
els.calibrate.addEventListener("click", () => sendCommand({ type: "calibrate" }));

(async () => {
  const r = await fetch("/api/settings");
  settings = await r.json();
  build();
  connectWS();
})();
