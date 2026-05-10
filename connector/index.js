import { WebSocket } from "ws";
import dgram from "node:dgram";

const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:8080/connector";
const OPENTRACK_HOST = process.env.OPENTRACK_HOST ?? "127.0.0.1";
const OPENTRACK_PORT = Number(process.env.OPENTRACK_PORT ?? 4242);

const udp = dgram.createSocket("udp4");
const buf = Buffer.allocUnsafe(48);

function sendPose({ x, y, z, yaw, pitch, roll }) {
  buf.writeDoubleLE(x, 0);
  buf.writeDoubleLE(y, 8);
  buf.writeDoubleLE(z, 16);
  buf.writeDoubleLE(yaw, 24);
  buf.writeDoubleLE(pitch, 32);
  buf.writeDoubleLE(roll, 40);
  udp.send(buf, 0, 48, OPENTRACK_PORT, OPENTRACK_HOST);
}

let ws;
let backoffMs = 500;

function connect() {
  ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    backoffMs = 500;
    console.log(`[connector] connected to relay ${RELAY_URL}`);
    console.log(`[connector] forwarding to OpenTrack ${OPENTRACK_HOST}:${OPENTRACK_PORT}`);
  });

  ws.on("message", (data) => {
    try {
      const pose = JSON.parse(data);
      if (pose && typeof pose.yaw === "number") sendPose(pose);
    } catch {}
  });

  ws.on("close", () => {
    console.log(`[connector] relay closed, retrying in ${backoffMs}ms`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 10_000);
  });

  ws.on("error", (err) => {
    console.error("[connector] ws error:", err.message);
    ws.close();
  });
}

connect();

process.on("SIGINT", () => {
  ws?.close();
  udp.close();
  process.exit(0);
});
