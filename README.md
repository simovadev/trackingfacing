# trackingfacing

Head-tracking for Microsoft Flight Simulator running on Shadow PC, using an iPhone as the camera. No Mac, no native app — pure web.

## Architecture

```
[iPhone Safari]              [Railway relay]              [Shadow VM]
 camera + FaceLandmarker  ─WS→  Node.js relay   ─WS→  Node.js connector
 6DoF head pose                                              │ UDP localhost
                                                             ▼
                                                       OpenTrack :4242
                                                             │
                                                             ▼
                                                          MSFS
```

Three components:

- **`webapp/`** — static HTML + ES module. Captures the face with MediaPipe `FaceLandmarker` (GPU), extracts yaw/pitch/roll/x/y/z from the facial transformation matrix, smooths with One Euro Filter, ships JSON over WebSocket.
- **`relay/`** — Express + `ws`. Serves the webapp and bridges two WebSocket endpoints: `/sender` (iPhone) and `/connector` (Shadow). Deployed to Railway.
- **`connector/`** — Node.js. Connects to the relay as `/connector`, receives JSON pose, sends UDP packets (6 little-endian doubles, 48 bytes) to OpenTrack on `127.0.0.1:4242`.

## OpenTrack setup (inside Shadow)

1. Install [OpenTrack](https://github.com/opentrack/opentrack/releases).
2. **Input**: `UDP over network`, port `4242`.
3. **Output**: `freetrack 2.0 Enhanced` (read by MSFS as TrackIR).
4. Click **Start**.

## Run locally

```bash
# Terminal 1
cd relay && npm install && npm start

# Terminal 2
cd connector && npm install && RELAY_URL=ws://localhost:8080/connector npm start
```

Open `http://localhost:8080` in a browser. iPhone Safari requires HTTPS for `getUserMedia`, so use the Railway deployment for phone testing.

## Environment variables

- **relay**: `PORT` (default `8080`)
- **connector**: `RELAY_URL` (default `ws://localhost:8080/connector`), `OPENTRACK_HOST` (`127.0.0.1`), `OPENTRACK_PORT` (`4242`)
