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

## Open questions (need a PT restart to test)

1. Does PT 9 **auto-detect** a `.pts` dropped into `<user folder>/extensions/`? The docs say PT Script Modules are "added by the user (or auto-detected during PT launch)". If it doesn't, there are fallbacks:
   - Find where PT stores the module list (`PT.conf` looks encoded) and whether it can be written safely.
   - As a last resort, a one-time guided step in the reCPT UI ("click Launch once").
2. Does `getUserFolder()` return `~/Cisco Packet Tracer 9.0.1`, the same on all three OSes?
3. Is "On Startup" kept for an auto-detected module, or does PT ask the user to confirm its privileges first? If it asks, the installer shows the user what to expect.
4. Windows/Linux: is the same web view + WebSocket transport allowed? It's expected to be, because it's the same QtWebEngine.

## Release shape

- **v0.x:** `npx recpt setup`, a Node script doing steps 1–6, plus the committed `agent/reCPT.pts` loader.
- **v1:** a Tauri app. It bundles `ptd` as a sidecar, runs setup on first launch, and supervises PT, including restarting it if it dies.
