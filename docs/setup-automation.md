# Setup automation plan

Goal: one installer (later inside the Tauri app) that takes a machine with Packet Tracer
installed to a working reCPT, with no clicking inside PT.

## What setup has to do

| Step | Today (manual) | Automated |
|---|---|---|
| 1. Find PT | — | Scan the known install paths: macOS `/Applications/Cisco Packet Tracer*/`, Windows `C:\Program Files\Cisco Packet Tracer*\`, Linux `/opt/pt`. Read the version and the user folder (`~/Cisco Packet Tracer <ver>/`). |
| 2. Install agent code | `#include` to an absolute repo path | Copy `agent/engine.js` to `<PT user folder>/extensions/reCPT/engine.js` |
| 3. Install the Script Module | Create it in PT's GUI, export it, add it, launch it | Drop a prebuilt **loader** `.pts` into `<PT user folder>/extensions/` (see below) |
| 4. Register the module + autostart | *Configure PT Script Modules → Launch* | Rely on PT's auto-detection at launch (**unverified**, see open questions) |
| 5. Run daemon | `npm run daemon` | macOS launchd agent, Windows Startup entry, Linux `systemd --user`. Later: a Tauri sidecar. |
| 6. Start PT as an engine | open PT | The daemon launches PT, then calls `pt hide` once the agent connects. Linux: run under Xvfb. |
| 7. NetAcad login | manual | Stays manual: PT stores the session after the first login. |

## Key idea: a loader `.pts` that never changes

`.pts` files are encrypted by PT, so CI can't build them. Instead, make **one** small module
whose `main.js` loads the real code from disk at start:

```js
// main.js inside reCPT.pts — built once in PT's GUI, committed to the repo as a binary
var __root = ipc.appWindow().getUserFolder() + "/extensions/reCPT/";
(0, eval)(String(ipc.systemFileManager().getFileContents(__root + "engine.js")));
```

- **Updating reCPT** only replaces `engine.js`. The `.pts` stays the same across releases.
- **No absolute paths** are baked in, so the same `.pts` works for every user and OS.
- **It needs the File Operations privilege**, which the module already requests.

## Test results (PT 9.0.1, macOS)

| Question | Result |
|---|---|
| Loader `.pts` + `engine.js` on disk | ✅ Works. The agent connects about 1 s after Start. |
| Auto-detect `extensions/reCPT.pts` | ❌ Not detected |
| Auto-detect `extensions/reCPT/reCPT.pts` (built-in layout) | ❌ Not detected. PT only auto-detects modules in its app bundle, which we must not modify. |
| Open `.pts` by double-click / `open` | ❌ `.pts` isn't a document type PT opens |
| Add via *Configure → Add* | ✅ Works, but the module arrives **Disabled with no privileges**. It has to be edited (On Startup + privileges) and re-exported once. |
| Persists across PT restarts | ✅ Starts by itself; the agent connects about 8 s after PT launches |
| `engine.js` update without touching PT | ✅ `npm run setup`, then restart PT |
| Clicking PT's radios/checkboxes through accessibility | ⚠️ The UI changes but PT doesn't save it. Only real clicks stick. Relevant if we ever script the first-time step. |

**Conclusion:** everything is automated except one first-time step inside PT (Add + Edit + Export,
about 1 minute). Next options to remove it:
1. Find out why an added `.pts` comes in without privileges. Maybe they need a publisher signature (PT supports `.p12` signing), and signed modules might be auto-accepted.
2. A guided "first-run" screen in the reCPT UI that walks the user through those clicks.

## Open questions

1. Do signed modules (`.p12` publisher signing) keep their privileges and startup mode when added?
2. Does `getUserFolder()` return `~/Cisco Packet Tracer 9.0.1`, the same on all three OSes?
3. Windows/Linux: is the same web view + WebSocket transport allowed? It's expected to be, because it's the same QtWebEngine.

## Release shape

- **v0.x:** `npx recpt setup`, a Node script doing steps 1–6, plus the committed `agent/reCPT.pts` loader.
- **v1:** a Tauri app. It bundles `ptd` as a sidecar, runs setup on first launch, and supervises PT, including restarting it if it dies.
