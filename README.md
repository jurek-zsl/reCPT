# reCPT — Packet Tracer's engine, a new UI

reCPT keeps Cisco Packet Tracer running as a (hidden) engine and puts a modern UI and CLI in
front of it. Simulation, IOS, `.pkt`/`.pka` files and activity grading all stay inside PT.
Everything goes through PT's official Script Module API: no reverse engineering, no file
decryption.

```
 ┌──────────── Cisco Packet Tracer (window can be hidden) ────────────┐
 │  Script Module "reCPT bridge" (com.ptbridge.agent)                  │
 │   engine.js ── full ipc.* access; polls the web view every 25 ms    │
 │   web view  ── Chromium; engine injects a WebSocket client into it  │
 └──────────────────────────┬──────────────────────────────────────────┘
                            │ ws://127.0.0.1:39150/agent
                   ┌────────┴────────┐
                   │   ptd (daemon)  │  token in ~/.ptbridge/token
                   └──┬──────────┬───┘
          HTTP /rpc   │          │  ws /events (terminal output, topology changes)
              ┌───────┴───┐  ┌───┴──────────────────────────┐
              │ pt (CLI)  │  │ reCPT UI  http://127.0.0.1:39150 │
              └───────────┘  └──────────────────────────────┘
```

## Status (tested against PT 9.0.1.0858 on macOS, arm64)

| | |
|---|---|
| ✅ Agent inside PT connects to `ptd` | via QtWebEngine 6.8.7. No "External Network Access" preference needed. |
| ✅ Read live state | version, open file, `.pka` flag, 16 devices / 14 links, ports, IPs, up/down. About 0.1 s per CLI call. |
| ✅ reCPT UI renders the real network | canvas, inspector with live port states, command palette (⌘K) |
| ✅ Hide / show PT's window | queries keep working while PT is hidden |
| ✅ Dev loop | edit `agent/engine.js`, then Stop/Start the module. PT re-reads it through `#include`. |
| ⏳ Write operations | add/move/delete devices, cables, IOS console. Built, **not yet run against real PT**, because the only open file was a lab we must not modify. |
| ⚠️ Activity score | PT refuses `getPercentageComplete()` without the activity's password |

### Things learned the hard way

- **PTMP / ExApps (TCP 39000):** the handshake works, but PT 9 rejects any app that isn't registered through an encrypted `.pta` file. Not used.
- **`$seev` / `$se`:** these page helpers are **not** available in the custom-interface page, so the page can't call the engine. The engine drives the page instead: `evaluateJavaScriptAsync` to inject code, `evaluateToVariant` to poll, and the `javascriptDone` event to read results.
- **`evaluateToVariant`** returns a request ID, not the value. The value arrives in `javascriptDone(id, result)`.
- **New Script Modules have to be exported to `.pts`** and added as persistent modules before they can start.
- **Helper objects sit outside the canvas.** PT parks objects like the Power Distribution Device at around (3894, 3885), so the UI ignores far-off objects when fitting the view.

## Layout

```
agent/engine.js    Script Engine (the module's main.js is just:  #include "<abs path>/agent/engine.js")
agent/bridge.htm   placeholder custom interface the web view loads
daemon/ptd.mjs     daemon + serves the UI, zero dependencies (Node >= 20)
ui/index.html      reCPT UI prototype (single file, no build)
cli/pt.mjs         CLI
research/ptmp-java/  PTMP probe + Apache Commons stand-ins (research only)
```

## Setup (one time, inside Packet Tracer)

1. **Create the module:** *Extensions → Scripting → New PT Script Module*.
   - **General tab:** name `reCPT bridge`, ID `com.ptbridge.agent`, Startup **On Startup**.
   - **Privileges:** Application, Activity, File Operations, Change User Interface, IPC, Get/Change Network Info, Simulation, Miscellaneous UI.
   - **Script Engine tab:** file `main.js` containing `#include "/abs/path/ptbridge/agent/engine.js"`.
   - **Custom Interfaces tab:** file `bridge.htm` containing `#include "/abs/path/ptbridge/agent/bridge.htm"`.
2. **Export it:** *Info → Export*. Save it as `reCPT.pts` in `~/Cisco Packet Tracer 9.0.1/extensions`, answer **No** to "expand includes", then **Yes** to "add as persistent module".
3. **Start it:** *Extensions → Scripting → Configure PT Script Modules → reCPT bridge → Launch*. From then on it starts with PT.

## Run

```bash
npm run daemon                 # then open http://127.0.0.1:39150
node cli/pt.mjs info
node cli/pt.mjs topo
node cli/pt.mjs hide           # PT keeps running as a background engine
node cli/pt.mjs show
```

## Next steps

1. Test write operations on a scratch file:
   - `addDevice` model strings;
   - `createLink` with automatic cable choice;
   - IOS console output (`outputWritten` field names, `--More--` handling).
2. Wrap `ui/` in Tauri. `ptd` becomes a sidecar that launches and supervises PT, starting it hidden.
3. Linux: run PT under Xvfb for a truly headless engine. Windows: same Script Module.
4. UI: a real terminal (xterm.js), packet/simulation mode, `.pka` instructions panel.
