#!/usr/bin/env node
// reCPT installer — puts the reCPT agent into Packet Tracer without clicking inside PT.
//
//   node setup/install.mjs              install / update
//   node setup/install.mjs --dry-run    show what would happen
//   node setup/install.mjs --uninstall  remove reCPT from PT
//   --user-folder <dir>                 override PT's user folder (e.g. "~/Cisco Packet Tracer 9.0.1")
//
// What it does:
//   1. finds Packet Tracer installs and their per-user folders
//   2. copies agent/engine.js  -> <user folder>/extensions/reCPT/engine.js   (the real agent)
//   3. copies agent/reCPT.pts  -> <user folder>/extensions/reCPT/reCPT.pts   (tiny loader module)
//   4. first install only: PT does NOT auto-detect user modules, so you add it once:
//      Extensions > Scripting > Configure PT Script Modules > Add > reCPT.pts,
//      then Edit > General: Startup "On Startup" + privileges > Export over the same file.
//      (Updates after that only replace engine.js.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const UNINSTALL = args.includes("--uninstall");
const userFolderArg = (() => { const i = args.indexOf("--user-folder"); return i >= 0 ? args[i + 1] : null; })();
const home = os.homedir();
const expand = (p) => p.replace(/^~(?=$|[\\/])/, home);

const say = (...a) => console.log(...a);
const step = (msg) => say((DRY ? "[dry-run] " : "") + msg);

// ---------------------------------------------------------------- 1. find PT
function findInstalls() {
  const found = [];
  const add = (version, appPath) => found.push({ version, appPath });
  const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

  if (process.platform === "darwin") {
    for (const name of list("/Applications")) {
      const m = /^Cisco Packet Tracer ([\d.]+)$/.exec(name);
      if (m) add(m[1], path.join("/Applications", name));
    }
  } else if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      for (const name of list(base)) {
        const m = /^Cisco Packet Tracer ([\d.]+)$/.exec(name);
        if (m) add(m[1], path.join(base, name));
      }
    }
  } else {
    for (const dir of ["/opt/pt", "/opt/packettracer"]) if (fs.existsSync(dir)) add("unknown", dir);
  }
  return found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

// Per-user folder PT creates on first launch (confirmed on macOS: ~/Cisco Packet Tracer <ver>).
function userFolderFor(install) {
  if (userFolderArg) return expand(userFolderArg);
  const candidates = [path.join(home, `Cisco Packet Tracer ${install.version}`), path.join(home, "pt")];
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

// ---------------------------------------------------------------- 2/3. copy files
function copy(src, dst) {
  step(`copy ${path.relative(ROOT, src)} -> ${dst}`);
  if (DRY) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function remove(p) {
  if (!fs.existsSync(p)) return;
  step(`remove ${p}`);
  if (!DRY) fs.rmSync(p, { recursive: true, force: true });
}

const installs = findInstalls();
if (!installs.length && !userFolderArg) {
  say("Packet Tracer not found. Install it from netacad.com (or pass --user-folder).");
  process.exit(1);
}
const targets = installs.length ? installs : [{ version: "unknown", appPath: "(given)" }];

for (const inst of targets) {
  const uf = userFolderFor(inst);
  const ext = path.join(uf, "extensions");
  say(`\nPacket Tracer ${inst.version}  (${inst.appPath})\n  user folder: ${uf}`);
  if (!fs.existsSync(uf)) {
    say("  ! user folder missing — start Packet Tracer once (and log in), then re-run setup.");
    continue;
  }
  if (UNINSTALL) {
    remove(path.join(ext, "reCPT"));
    remove(path.join(ext, "reCPT.pts")); // pre-0.1 location
    continue;
  }
  copy(path.join(ROOT, "agent", "engine.js"), path.join(ext, "reCPT", "engine.js"));
  const pts = path.join(ext, "reCPT", "reCPT.pts");
  const firstInstall = !fs.existsSync(pts);
  copy(path.join(ROOT, "agent", "reCPT.pts"), pts);
  remove(path.join(ext, "reCPT.pts")); // pre-0.1 location
  if (firstInstall) say(`  first install: in PT add it once via Extensions > Scripting > Configure PT Script Modules > Add > ${pts}`);
}

say(UNINSTALL
  ? "\nreCPT removed. Restart Packet Tracer."
  : "\nDone. Restart Packet Tracer, then run:  npm run daemon   and open http://127.0.0.1:39150");
