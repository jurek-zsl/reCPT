#!/usr/bin/env node
// pt — command line for Packet Tracer via the ptbridge daemon (ptd).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const PORT = Number(process.env.PTB_PORT || 39150);
const BASE = `http://127.0.0.1:${PORT}`;
const tokenPath = path.join(os.homedir(), ".ptbridge", "token");
const TOKEN = (() => { try { return fs.readFileSync(tokenPath, "utf8").trim(); } catch { return ""; } })();

const HELP = `pt — drive Cisco Packet Tracer from the terminal

  pt status                         daemon + agent connection
  pt info                           PT version, open file, counts
  pt topo [--json]                  devices, ports, links
  pt add <type> <model> [x y]       e.g. pt add router 2911 200 150
  pt rm <device>
  pt mv <device> <x> <y>
  pt rename <device> <new>
  pt link <dev> <port> <dev> <port> [cable]   cable: auto|straight|cross|serial|console|fiber…
  pt unlink <dev> <port>
  pt cli <dev> "<cmd>" ["<cmd>" …]  run IOS commands, print output
  pt term <dev>                     interactive console
  pt open <file.pkt|pka>   pt save   pt saveas <file>   pt new
  pt hide | pt show                 hide/show the Packet Tracer window
  pt score                          activity (.pka) completion, graded by PT
  pt eval "<js>"                    run raw JS in PT's script engine (ipc.* available)
`;

async function rpc(call, args = []) {
  let r;
  try {
    r = await fetch(`${BASE}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(call === "__code" ? { code: args } : { call, args }),
    });
  } catch {
    die(`can't reach ptd on ${BASE} — start it with: node daemon/ptd.mjs`);
  }
  const j = await r.json();
  if (!j.ok) die(j.error || "error");
  return j.result;
}

function die(msg) { console.error("pt: " + msg); process.exit(1); }
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

function events() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/events?token=${TOKEN}`);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("events socket failed"));
  });
}

// Send IOS commands and stream the device's terminal output until it goes quiet.
async function runCli(device, cmds, { idleMs = 800, interactive = false } = {}) {
  const ws = await events();
  let idleTimer, done;
  const finished = new Promise((r) => (done = r));
  const bump = () => { clearTimeout(idleTimer); if (!interactive) idleTimer = setTimeout(done, idleMs); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.event === "term" && m.device === device && m.data != null) { process.stdout.write(m.data); bump(); }
  };
  await rpc("watchTerm", [device]);
  for (const c of cmds) { await rpc("cli", [device, c]); bump(); }
  if (interactive) return ws;
  await finished;
  ws.close();
  process.stdout.write("\n");
}

const [cmd, ...a] = process.argv.slice(2);
switch (cmd) {
  case undefined: case "-h": case "--help": case "help": console.log(HELP); break;
  case "status": {
    try { out(await (await fetch(`${BASE}/status`)).json()); } catch { die(`ptd not running on ${BASE}`); }
    break;
  }
  case "info": out(await rpc("info")); break;
  case "topo": {
    const t = await rpc("topology");
    if (a.includes("--json")) { out(t); break; }
    for (const d of t.devices) {
      console.log(`${d.name.padEnd(14)} ${String(d.model).padEnd(14)} @(${d.x},${d.y})${d.power ? "" : "  [off]"}`);
      for (const p of d.ports) if (p.linked || (p.ip && p.ip !== "0.0.0.0"))
        console.log(`    ${p.name.padEnd(22)} ${p.up ? "up  " : "down"} ${p.ip && p.ip !== "0.0.0.0" ? p.ip + "/" + p.mask : ""}`);
    }
    if (t.links.length) console.log("\nlinks:");
    for (const l of t.links) console.log(`  ${l.a?.device}:${l.a?.port}  ──  ${l.b?.device}:${l.b?.port}`);
    break;
  }
  case "add": out(await rpc("addDevice", [a[0], a[1], Number(a[2] || 100), Number(a[3] || 100)])); break;
  case "rm": out(await rpc("removeDevice", [a[0]])); break;
  case "mv": out(await rpc("move", [a[0], Number(a[1]), Number(a[2])])); break;
  case "rename": out(await rpc("rename", [a[0], a[1]])); break;
  case "link": out(await rpc("link", [a[0], a[1], a[2], a[3], a[4] || "auto"])); break;
  case "unlink": out(await rpc("unlink", [a[0], a[1]])); break;
  case "cli": if (a.length < 2) die('usage: pt cli <device> "<command>" …'); await runCli(a[0], a.slice(1)); break;
  case "term": {
    if (!a[0]) die("usage: pt term <device>");
    const ws = await runCli(a[0], [""], { interactive: true });
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => rpc("cli", [a[0], line]));
    rl.on("close", () => { ws.close(); process.exit(0); });
    break;
  }
  case "open": out(await rpc("open", [path.resolve(a[0])])); break;
  case "save": out(await rpc("save")); break;
  case "saveas": out(await rpc("saveAs", [path.resolve(a[0])])); break;
  case "new": out(await rpc("newFile")); break;
  case "hide": out(await rpc("hide")); break;
  case "show": out(await rpc("show")); break;
  case "score": out((await rpc("score")) ?? "no activity file open"); break;
  case "eval": out(await rpc("__code", a.join(" "))); break;
  default: die(`unknown command "${cmd}" — try pt help`);
}
