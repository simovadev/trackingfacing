import { WebSocket, WebSocketServer } from "ws";
import dgram from "node:dgram";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ----- Paths (must work both in dev and inside a pkg .exe) -------------

const isPkg = typeof process.pkg !== "undefined";
const __dirname = isPkg ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
// In pkg builds the snapshot exposes assets via path.join(__dirname, "ui").
// In dev mode we just resolve next to this file.
const uiDir = isPkg ? path.join(path.dirname(fileURLToPath(import.meta.url)), "ui") : path.join(__dirname, "ui");

const settingsDir = path.join(os.homedir(), "AppData", "Roaming", "tracksmfs");
const settingsPath = path.join(settingsDir, "settings.json");

// ----- Configuration ---------------------------------------------------

const RELAY_URL = process.env.RELAY_URL ?? "wss://trackingfacing-production.up.railway.app/connector";
const OPENTRACK_HOST = process.env.OPENTRACK_HOST ?? "127.0.0.1";
const OPENTRACK_PORT = Number(process.env.OPENTRACK_PORT ?? 4242);
const TUNER_PORT = Number(process.env.TUNER_PORT ?? 7777);

const AXES = ["yaw", "pitch", "roll", "x", "y", "z"];

function defaultSettings() {
  const tx = (gain) => ({ gain, offset: 0, deadzone: 0, invert: false, enabled: true });
  return {
    yaw:   tx(1.0),
    pitch: tx(1.0),
    roll:  { gain: 0,   offset: 0, deadzone: 0, invert: false, enabled: false },
    x:     tx(1.0),
    y:     { gain: 0,   offset: 0, deadzone: 0, invert: false, enabled: false },
    z:     tx(1.0),
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
const buf = Buffer.allocUnsafe(48);

function applyAxis(value, conf) {
  if (!conf.enabled) return 0;
  let v = value + conf.offset;
  if (conf.invert) v = -v;
  if (conf.deadzone > 0 && Math.abs(v) < conf.deadzone) return 0;
  return v * conf.gain;
}

function sendPose(rawPose) {
  const out = {
    x:     applyAxis(rawPose.x ?? 0,     settings.x),
    y:     applyAxis(rawPose.y ?? 0,     settings.y),
    z:     applyAxis(rawPose.z ?? 0,     settings.z),
    yaw:   applyAxis(rawPose.yaw ?? 0,   settings.yaw),
    pitch: applyAxis(rawPose.pitch ?? 0, settings.pitch),
    roll:  applyAxis(rawPose.roll ?? 0,  settings.roll),
  };
  buf.writeDoubleLE(out.x, 0);
  buf.writeDoubleLE(out.y, 8);
  buf.writeDoubleLE(out.z, 16);
  buf.writeDoubleLE(out.yaw, 24);
  buf.writeDoubleLE(out.pitch, 32);
  buf.writeDoubleLE(out.roll, 40);
  udp.send(buf, 0, 48, OPENTRACK_PORT, OPENTRACK_HOST);
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

function connectRelay() {
  ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    backoffMs = 500;
    state.relayConnected = true;
    console.log(`[connector] connected to relay ${RELAY_URL}`);
    console.log(`[connector] forwarding to OpenTrack ${OPENTRACK_HOST}:${OPENTRACK_PORT}`);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg && typeof msg === "object" && typeof msg.type === "string") {
        if (msg.type === "senderState") {
          state.phoneConnected = !!msg.connected;
          if (!state.phoneConnected) {
            // Wipe last values so the UI does not show stale numbers.
            state.lastIn = null;
            state.lastOut = null;
          }
        }
        return;
      }
      if (msg && typeof msg.yaw === "number") sendPose(msg);
    } catch {}
  });

  ws.on("close", () => {
    state.relayConnected = false;
    state.phoneConnected = false;
    console.log(`[connector] relay closed, retrying in ${backoffMs}ms`);
    setTimeout(connectRelay, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10_000);
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
        broadcastTuner({ type: "settings", settings });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(settings));
      } catch {
        res.writeHead(400);
        res.end("bad json");
      }
    });
    return;
  }
  if (req.url === "/api/reset" && req.method === "POST") {
    settings = defaultSettings();
    saveSettings(settings);
    broadcastTuner({ type: "settings", settings });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(settings));
  }
  if (req.url === "/api/command" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const cmd = JSON.parse(body);
        if (ws?.readyState === 1) ws.send(JSON.stringify(cmd));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
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
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: tuner, path: "/ws" });
wss.on("connection", (client) => {
  tunerClients.add(client);
  client.send(JSON.stringify({ type: "settings", settings }));
  client.on("close", () => tunerClients.delete(client));
});

tuner.listen(TUNER_PORT, "127.0.0.1", () => {
  console.log(`[connector] tuner UI on http://localhost:${TUNER_PORT}`);
});

connectRelay();

process.on("SIGINT", () => {
  ws?.close();
  udp.close();
  tuner.close();
  process.exit(0);
});
