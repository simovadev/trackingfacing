import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

const app = express();
app.use(express.static(path.resolve(__dirname, "../webapp")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

const wssSender = new WebSocketServer({ noServer: true });
const wssConnector = new WebSocketServer({ noServer: true });

let connector = null;
let sender = null;

server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url === "/sender") {
    wssSender.handleUpgrade(req, socket, head, (ws) => wssSender.emit("connection", ws, req));
  } else if (url === "/connector") {
    wssConnector.handleUpgrade(req, socket, head, (ws) => wssConnector.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wssConnector.on("connection", (ws) => {
  if (connector) connector.close();
  connector = ws;
  console.log("[relay] connector attached");
  // Forward connector -> sender (commands like start/pause/calibrate).
  ws.on("message", (data, isBinary) => {
    if (sender?.readyState === 1) sender.send(data, { binary: isBinary });
  });
  ws.on("close", () => {
    if (connector === ws) connector = null;
    console.log("[relay] connector detached");
  });
  // Inform connector of the current sender presence.
  ws.send(JSON.stringify({ type: "senderState", connected: !!sender }));
});

wssSender.on("connection", (ws) => {
  if (sender) sender.close();
  sender = ws;
  console.log("[relay] sender attached");
  // Forward sender -> connector (head poses + status messages).
  ws.on("message", (data, isBinary) => {
    if (connector?.readyState === 1) connector.send(data, { binary: isBinary });
  });
  ws.on("close", () => {
    if (sender === ws) sender = null;
    console.log("[relay] sender detached");
    if (connector?.readyState === 1) {
      connector.send(JSON.stringify({ type: "senderState", connected: false }));
    }
  });
  if (connector?.readyState === 1) {
    connector.send(JSON.stringify({ type: "senderState", connected: true }));
  }
});

server.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));
