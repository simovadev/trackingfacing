"use strict";

const { WebSocket, WebSocketServer } = require("ws");
const dgram = require("node:dgram");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ----- Paths (must work both in dev and inside a pkg .exe) -------------

// In a pkg snapshot, __dirname points inside the virtual filesystem and
// can be used to read files declared as assets in package.json.
const isPkg = typeof process.pkg !== "undefined";
const uiDir = path.join(__dirname, "ui");

const settingsDir = path.join(os.homedir(), "AppData", "Roaming", "tracksmfs");
const settingsPath = path.join(settingsDir, "settings.json");

// ----- Configuration ---------------------------------------------------

const RELAY_URL = process.env.RELAY_URL || "wss://trackingfacing-production.up.railway.app/connector";
const OPENTRACK_HOST = process.env.OPENTRACK_HOST || "127.0.0.1";
const OPENTRACK_PORT = Number(process.env.OPENTRACK_PORT || 4242);
const TUNER_PORT = Number(process.env.TUNER_PORT || 7777);

const AXES = ["yaw", "pitch", "roll", "x", "y", "z"];

function defaultSettings() {
  const tx = (gain, expo) => ({ gain, offset: 0, deadzone: 0, expo: expo == null ? 1.5 : expo, invert: false, enabled: true });
  return {
    yaw:   tx(1.0, 1.6),
    pitch: tx(1.0, 1.5),
    roll:  { gain: 0,   offset: 0, deadzone: 0, expo: 1.0, invert: false, enabled: false },
    x:     tx(1.0, 1.3),
    y:     { gain: 0,   offset: 0, deadzone: 0, expo: 1.0, invert: false, enabled: false },
    z:     tx(1.0, 1.3),
  };
}

function loadSettings() {
  try {
    if (!fs.existsSync(settingsPath)) return defaultSettings();
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const merged = defaultSettings();
    for (const a of AXES) if (parsed[a]) Object.assign(merged[a], parsed[a]);
    return merged;
  } catch (e) {
    console.error("[connector] failed to load settings:", e.message);
    return defaultSettings();
  }
}

function saveSettings(s) {
  try {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
    return true;
  } catch (e) {
    console.error("[connector] failed to save settings:", e.message);
    return false;
  }
}

let settings = loadSettings();

// ----- UDP to OpenTrack (6 LE doubles, 48 bytes) -----------------------

const udp = dgram.createSocket("udp4");
const udpBuf = Buffer.allocUnsafe(48);

function applyAxis(value, conf) {
  if (!conf.enabled) return 0;
  let v = value + (conf.offset || 0);
  if (conf.invert) v = -v;
  const dz = conf.deadzone || 0;
  if (dz > 0) {
    if (Math.abs(v) < dz) return 0;
    v = v > 0 ? v - dz : v + dz;
  }
  const expo = conf.expo == null ? 1 : conf.expo;
  if (expo !== 1) v = Math.sign(v) * Math.pow(Math.abs(v), expo);
  return v * (conf.gain == null ? 1 : conf.gain);
}

function sendPose(rawPose) {
  const out = {
    x:     applyAxis(rawPose.x || 0,     settings.x),
    y:     applyAxis(rawPose.y || 0,     settings.y),
    z:     applyAxis(rawPose.z || 0,     settings.z),
    yaw:   applyAxis(rawPose.yaw || 0,   settings.yaw),
    pitch: applyAxis(rawPose.pitch || 0, settings.pitch),
    roll:  applyAxis(rawPose.roll || 0,  settings.roll),
  };
  udpBuf.writeDoubleLE(out.x, 0);
  udpBuf.writeDoubleLE(out.y, 8);
  udpBuf.writeDoubleLE(out.z, 16);
  udpBuf.writeDoubleLE(out.yaw, 24);
  udpBuf.writeDoubleLE(out.pitch, 32);
  udpBuf.writeDoubleLE(out.roll, 40);
  udp.send(udpBuf, 0, 48, OPENTRACK_PORT, OPENTRACK_HOST);
  state.lastIn = rawPose;
  state.lastOut = out;
  state.packets++;
}

// ----- State + tuner broadcast -----------------------------------------

const state = {
  relayConnected: false,
  phoneConnected: false,
  packets: 0,
  lastIn: null,
  lastOut: null,
};

const tunerClients = new Set();

function broadcastTuner(obj) {
  const payload = JSON.stringify(obj);
  for (const c of tunerClients) if (c.readyState === 1) c.send(payload);
}

setInterval(() => {
  if (tunerClients.size === 0) return;
  broadcastTuner({
    type: "live",
    relayConnected: state.relayConnected,
    phoneConnected: state.phoneConnected,
    packets: state.packets,
    in: state.lastIn,
    out: state.lastOut,
  });
}, 100);

// ----- Relay (Railway) WebSocket client --------------------------------

let ws;
let backoffMs = 500;
let heartbeat = null;
let lastPongAt = 0;

function decodeBinaryPose(buf) {
  if (buf.length !== 25 || buf[0] !== 0x01) return null;
  return {
    yaw:   buf.readFloatLE(1),
    pitch: buf.readFloatLE(5),
    roll:  buf.readFloatLE(9),
    x:     buf.readFloatLE(13),
    y:     buf.readFloatLE(17),
    z:     buf.readFloatLE(21),
  };
}

function connectRelay() {
  ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    backoffMs = 500;
    state.relayConnected = true;
    lastPongAt = Date.now();
    console.log("[connector] connected to relay " + RELAY_URL);
    console.log("[connector] forwarding to OpenTrack " + OPENTRACK_HOST + ":" + OPENTRACK_PORT);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      if (Date.now() - lastPongAt > 15000) {
        console.warn("[connector] no pong for 15s, forcing reconnect");
        try { ws.close(); } catch (_) {}
      }
    }, 5000);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary || (Buffer.isBuffer(data) && data[0] === 0x01)) {
      const pose = decodeBinaryPose(data);
      if (pose) sendPose(pose);
      return;
    }
    try {
      const msg = JSON.parse(data);
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "pong") { lastPongAt = Date.now(); return; }
      if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", t: msg.t })); return; }
      if (msg.type === "senderState") {
        state.phoneConnected = !!msg.connected;
        if (!state.phoneConnected) {
          state.lastIn = null;
          state.lastOut = null;
          broadcastTuner({ type: "rtc", payload: { kind: "phoneGone" } });
        }
        return;
      }
      if (msg.type === "rtc") {
        broadcastTuner({ type: "rtc", payload: msg.payload });
        return;
      }
      if (msg.type === "calibrationDone") {
        broadcastTuner({ type: "calibrationDone" });
        return;
      }
      if (typeof msg.yaw === "number") sendPose(msg);
    } catch (_) {}
  });

  ws.on("close", () => {
    state.relayConnected = false;
    state.phoneConnected = false;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    console.log("[connector] relay closed, retrying in " + backoffMs + "ms");
    setTimeout(connectRelay, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10000);
  });

  ws.on("error", (err) => {
    console.error("[connector] ws error:", err.message);
    ws.close();
  });
}

// ----- Local tuner HTTP + WS -------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

const tuner = http.createServer((req, res) => {
  if (req.url === "/api/settings" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(settings));
  }
  if (req.url === "/api/settings" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const incoming = JSON.parse(body);
        const merged = defaultSettings();
        for (const a of AXES) if (incoming[a]) Object.assign(merged[a], incoming[a]);
        settings = merged;
        saveSettings(settings);
        broadcastTuner({ type: "settings", settings: settings });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(settings));
      } catch (_) {
        res.writeHead(400);
        res.end("bad json");
      }
    });
    return;
  }
  if (req.url === "/api/reset" && req.method === "POST") {
    settings = defaultSettings();
    saveSettings(settings);
    broadcastTuner({ type: "settings", settings: settings });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(settings));
  }
  if (req.url === "/api/command" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const cmd = JSON.parse(body);
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(cmd));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (_) {
        res.writeHead(400);
        res.end("bad json");
      }
    });
    return;
  }
  // Static files
  const reqPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(uiDir, reqPath);
  if (!filePath.startsWith(uiDir)) {
    res.writeHead(403); return res.end("forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: tuner, path: "/ws" });
wss.on("connection", (client) => {
  tunerClients.add(client);
  client.isAlive = true;
  client.on("pong", () => { client.isAlive = true; });
  client.send(JSON.stringify({ type: "settings", settings: settings }));
  client.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "rtc" && ws && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    } catch (_) {}
  });
  client.on("close", () => tunerClients.delete(client));
});

setInterval(() => {
  for (const c of tunerClients) {
    if (!c.isAlive) { try { c.terminate(); } catch (_) {} continue; }
    c.isAlive = false;
    try { c.ping(); } catch (_) {}
  }
}, 10000);

tuner.listen(TUNER_PORT, "127.0.0.1", () => {
  console.log("[connector] tuner UI on http://localhost:" + TUNER_PORT);
});

connectRelay();

process.on("SIGINT", () => {
  if (ws) ws.close();
  udp.close();
  tuner.close();
  process.exit(0);
});
