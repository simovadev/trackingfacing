"use strict";

const { WebSocket, WebSocketServer } = require("ws");
const dgram = require("node:dgram");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

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
    roll:  tx(1.0, 1.2),
    // Translations: lower default gain so close-up movements aren't
    // overwhelming. Distance compensation already happens on the phone.
    x:     tx(0.5, 1.4),
    y:     tx(0.5, 1.4),
    z:     tx(0.6, 1.3),
    // Gaze-driven mouse cursor. enabled here means "the connector will
    // move the cursor when phone sends gaze". The user can also pause
    // it from the tuner without losing the calibration / sensitivity.
    gaze: {
      enabled: false,
      sensitivityX: 1.0,   // multiplier on the normalized [-1,+1] gaze
      sensitivityY: 1.0,
      deadzone: 0.05,      // ignore tiny gaze around center
      smoothing: 0.25,     // 0 = no smoothing, 1 = max lag
    },
  };
}

function loadSettings() {
  try {
    if (!fs.existsSync(settingsPath)) return defaultSettings();
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const merged = defaultSettings();
    for (const a of AXES) if (parsed[a]) Object.assign(merged[a], parsed[a]);
    if (parsed.gaze && typeof parsed.gaze === "object") Object.assign(merged.gaze, parsed.gaze);
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

// ----- Persistent PowerShell mouse driver ------------------------------
//
// Spawning powershell.exe per cursor update would cost ~50 ms per call,
// way too slow for a 60 Hz tracker. Instead we spawn ONE long-running
// PowerShell, hand it a tiny script that reads "X,Y" lines from stdin
// and calls Cursor.Position on each. Latency drops to ~1-2 ms.
//
// The script also prints the primary screen resolution once so we know
// where to map gaze coordinates.

const mouse = {
  proc: null,
  screenW: 1920,
  screenH: 1080,
  lastSentX: 0,
  lastSentY: 0,
  smoothedX: 0,
  smoothedY: 0,
  hasSmooth: false,
};

function startMouseDriver() {
  if (mouse.proc) return;
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Write-Host ("RESOLUTION " + $b.Width + " " + $b.Height)
    while ($line = [Console]::In.ReadLine()) {
      $parts = $line -split ','
      if ($parts.Count -eq 2) {
        $x = [int]$parts[0]
        $y = [int]$parts[1]
        [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
      }
    }
  `.trim();
  try {
    mouse.proc = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", script,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    mouse.proc.stdout.setEncoding("utf8");
    mouse.proc.stdout.on("data", (chunk) => {
      const m = chunk.match(/RESOLUTION\s+(\d+)\s+(\d+)/);
      if (m) {
        mouse.screenW = Number(m[1]);
        mouse.screenH = Number(m[2]);
        console.log("[mouse] screen detected: " + mouse.screenW + "x" + mouse.screenH);
      }
    });
    mouse.proc.on("exit", () => { mouse.proc = null; });
    mouse.proc.on("error", (e) => { console.error("[mouse] driver error:", e.message); mouse.proc = null; });
  } catch (e) {
    console.error("[mouse] failed to start driver:", e.message);
  }
}

function moveCursorTo(x, y) {
  if (!mouse.proc) return;
  const ix = Math.round(Math.max(0, Math.min(mouse.screenW - 1, x)));
  const iy = Math.round(Math.max(0, Math.min(mouse.screenH - 1, y)));
  if (ix === mouse.lastSentX && iy === mouse.lastSentY) return;
  mouse.lastSentX = ix; mouse.lastSentY = iy;
  try { mouse.proc.stdin.write(ix + "," + iy + "\n"); } catch (_) {}
}

// Convert normalized gaze [-1, +1] into screen coordinates using
// sensitivity/deadzone/smoothing from settings.gaze.
function applyGazeToCursor(gazeX, gazeY) {
  const g = settings.gaze;
  if (!g || !g.enabled) {
    mouse.hasSmooth = false;
    return;
  }
  if (!Number.isFinite(gazeX) || !Number.isFinite(gazeY)) return;
  // Deadzone in normalized space.
  const dz = Number.isFinite(g.deadzone) ? g.deadzone : 0;
  let nx = Math.abs(gazeX) < dz ? 0 : (gazeX - Math.sign(gazeX) * dz) / (1 - dz);
  let ny = Math.abs(gazeY) < dz ? 0 : (gazeY - Math.sign(gazeY) * dz) / (1 - dz);
  nx *= (Number.isFinite(g.sensitivityX) ? g.sensitivityX : 1);
  ny *= (Number.isFinite(g.sensitivityY) ? g.sensitivityY : 1);
  // Clamp post-sensitivity so we don't push the cursor off-screen.
  nx = Math.max(-1, Math.min(1, nx));
  ny = Math.max(-1, Math.min(1, ny));
  // EMA smoothing.
  const alpha = 1 - Math.max(0, Math.min(0.99, Number.isFinite(g.smoothing) ? g.smoothing : 0));
  if (!mouse.hasSmooth) { mouse.smoothedX = nx; mouse.smoothedY = ny; mouse.hasSmooth = true; }
  else {
    mouse.smoothedX = alpha * nx + (1 - alpha) * mouse.smoothedX;
    mouse.smoothedY = alpha * ny + (1 - alpha) * mouse.smoothedY;
  }
  const cx = (mouse.smoothedX + 1) * 0.5 * mouse.screenW;
  const cy = (mouse.smoothedY + 1) * 0.5 * mouse.screenH;
  moveCursorTo(cx, cy);
}

const udp = dgram.createSocket("udp4");
const udpBuf = Buffer.allocUnsafe(48);

// Per-axis "full scale" used to normalize the value before applying expo.
// Must match the TARGET used on the phone side: yaw +/-90, pitch +/-60,
// X/Z +/-15. Used so that expo curves the response without exploding
// the magnitude (e.g. 70^1.6 would give ~900).
const SCALE = { yaw: 90, pitch: 60, roll: 30, x: 15, y: 15, z: 15 };

function applyAxis(value, conf, scale) {
  if (!conf || !conf.enabled) return 0;
  if (!Number.isFinite(value)) return 0;
  let v = value + (Number.isFinite(conf.offset) ? conf.offset : 0);
  if (conf.invert) v = -v;
  const dz = Number.isFinite(conf.deadzone) ? conf.deadzone : 0;
  if (dz > 0) {
    if (Math.abs(v) < dz) return 0;
    v = v > 0 ? v - dz : v + dz;
  }
  const expo = Number.isFinite(conf.expo) ? conf.expo : 1;
  if (expo !== 1 && scale > 0) {
    const n = Math.max(-1, Math.min(1, v / scale));
    v = Math.sign(n) * Math.pow(Math.abs(n), expo) * scale;
  }
  const gain = Number.isFinite(conf.gain) ? conf.gain : 1;
  const out = v * gain;
  return Number.isFinite(out) ? out : 0;
}

function sendPose(rawPose) {
  // Drive the Windows cursor from the gaze axes if enabled. The gaze
  // values from the phone are pre-normalized to [-1, +1] using the
  // user's gaze calibration, so we just pass them through.
  applyGazeToCursor(rawPose.gazeX || 0, rawPose.gazeY || 0);

  const out = {
    x:     applyAxis(rawPose.x || 0,     settings.x,     SCALE.x),
    y:     applyAxis(rawPose.y || 0,     settings.y,     SCALE.y),
    z:     applyAxis(rawPose.z || 0,     settings.z,     SCALE.z),
    yaw:   applyAxis(rawPose.yaw || 0,   settings.yaw,   SCALE.yaw),
    pitch: applyAxis(rawPose.pitch || 0, settings.pitch, SCALE.pitch),
    roll:  applyAxis(rawPose.roll || 0,  settings.roll,  SCALE.roll),
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
let debugBuffer = null; // null = not recording, [] = recording in progress

// Binary pose frame layout:
//   0x01 + 6 float32 (legacy, 25 bytes) -> head pose only
//   0x02 + 8 float32 (current, 33 bytes) -> head pose + gazeX + gazeY
function decodeBinaryPose(buf) {
  let pose;
  if (buf.length === 33 && buf[0] === 0x02) {
    pose = {
      yaw:   buf.readFloatLE(1),
      pitch: buf.readFloatLE(5),
      roll:  buf.readFloatLE(9),
      x:     buf.readFloatLE(13),
      y:     buf.readFloatLE(17),
      z:     buf.readFloatLE(21),
      gazeX: buf.readFloatLE(25),
      gazeY: buf.readFloatLE(29),
    };
  } else if (buf.length === 25 && buf[0] === 0x01) {
    pose = {
      yaw:   buf.readFloatLE(1),
      pitch: buf.readFloatLE(5),
      roll:  buf.readFloatLE(9),
      x:     buf.readFloatLE(13),
      y:     buf.readFloatLE(17),
      z:     buf.readFloatLE(21),
      gazeX: 0,
      gazeY: 0,
    };
  } else {
    return null;
  }
  // Drop the packet outright if any component is not finite.
  for (const k of AXES) if (!Number.isFinite(pose[k])) return null;
  if (!Number.isFinite(pose.gazeX) || !Number.isFinite(pose.gazeY)) {
    pose.gazeX = 0; pose.gazeY = 0;
  }
  return pose;
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
      if (msg.type === "calibrationUpdated") {
        // Phone ack after a manual setCalibration edit. Forward to
        // the tuner so it can flash the cell that just changed.
        broadcastTuner({ type: "calibrationUpdated", rejected: msg.rejected });
        return;
      }
      if (msg.type === "phoneStatus") {
        broadcastTuner({ type: "phoneStatus", phone: msg });
        return;
      }
      if (msg.type === "debugRecordingStart") {
        debugBuffer = [];
        broadcastTuner({ type: "debug", phase: "start" });
        return;
      }
      if (msg.type === "debugFrame") {
        if (debugBuffer) {
          // Snapshot current OpenTrack output (after gain/expo) too.
          const out = state.lastOut ? { ...state.lastOut } : null;
          debugBuffer.push({
            t: msg.t,
            matrix: msg.matrix,
            raw: msg.raw,
            center: msg.center,
            mode: msg.mode,
            bypass: msg.bypass,
            opentrackOut: out,
          });
        }
        return;
      }
      if (msg.type === "debugRecordingEnd") {
        if (debugBuffer) {
          const path2 = require("node:path");
          const dest = path2.join(settingsDir, "debug-recording.json");
          try {
            fs.mkdirSync(settingsDir, { recursive: true });
            fs.writeFileSync(dest, JSON.stringify({
              capturedAt: new Date().toISOString(),
              frames: debugBuffer,
              settings,
            }, null, 2));
            console.log("[connector] debug recording saved: " + dest + " (" + debugBuffer.length + " frames)");
            broadcastTuner({ type: "debug", phase: "end", path: dest, frames: debugBuffer.length });
          } catch (e) {
            console.error("[connector] debug write failed:", e.message);
            broadcastTuner({ type: "debug", phase: "error", message: e.message });
          }
          debugBuffer = null;
        }
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
        if (incoming.gaze && typeof incoming.gaze === "object") Object.assign(merged.gaze, incoming.gaze);
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

startMouseDriver();
connectRelay();

process.on("SIGINT", () => {
  if (ws) ws.close();
  if (mouse.proc) { try { mouse.proc.kill(); } catch (_) {} }
  udp.close();
  tuner.close();
  process.exit(0);
});
