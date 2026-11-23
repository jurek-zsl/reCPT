#!/usr/bin/env node
// reCPT MCP server — lets AI agents (Claude Code, Claude Desktop, Cursor, …) drive Cisco
// Packet Tracer through the reCPT daemon. Zero dependencies; speaks MCP over stdio.
//
//   claude mcp add recpt -- node /path/to/reCPT/mcp/server.mjs
//
// Needs: Packet Tracer running with the reCPT module, and `npm run daemon`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const PORT = Number(process.env.PTB_PORT || 39150);
const BASE = `http://127.0.0.1:${PORT}`;
const token = () => { try { return fs.readFileSync(path.join(os.homedir(), ".ptbridge", "token"), "utf8").trim(); } catch { return ""; } };

async function post(route, body) {
  let r;
  try {
    r = await fetch(BASE + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`reCPT daemon not reachable on ${BASE}. Start it with: npm run daemon (in the reCPT repo)`);
  }
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "error");
  return j.result;
}
const rpc = (call, ...args) => post("/rpc", { call, args });
const exec = (device, commands, timeoutMs) => post("/exec", { device, commands, timeoutMs });

const htmlToText = (h) => String(h)
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
  .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
  .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\n{3,}/g, "\n\n").trim();

function topoText(t) {
  const lines = [];
  for (const d of t.devices) {
    if (Math.abs(d.x) > 3000) continue; // PT helper objects off-canvas
    lines.push(`${d.name}  [${d.model}]${d.power === false ? " (off)" : ""}`);
    for (const p of d.ports) if (p.linked || (p.ip && p.ip !== "0.0.0.0"))
      lines.push(`  ${p.name}  ${p.up ? "up" : "down"}${p.ip && p.ip !== "0.0.0.0" ? "  " + p.ip + "/" + p.mask : ""}`);
  }
  lines.push("", "links:");
  for (const l of t.links) if (l.a && l.b) lines.push(`  ${l.a.device}:${l.a.port} <-> ${l.b.device}:${l.b.port}`);
  return lines.join("\n");
}

const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });
const strs = (description) => ({ type: "array", items: { type: "string" }, description });

const TOOLS = [
  { name: "recpt_status", description: "Check reCPT + Packet Tracer: PT version, open file, whether it is an activity (.pka), device/link counts.",
    inputSchema: S({}), run: async () => JSON.stringify(await rpc("info"), null, 2) },

  { name: "recpt_topology", description: "List all devices (PT names, models, ports with up/down and IPs) and all links. Device names here are what every other tool expects.",
    inputSchema: S({}), run: async () => topoText(await rpc("topology")) },

  { name: "recpt_activity", description: "For an activity (.pka): the instruction pages as text, and the completion score if PT allows reading it. Read this first when asked to do an exercise.",
    inputSchema: S({}), run: async () => {
      const a = await rpc("activity");
      if (!a.isActivity) return "The open file is not an activity (.pka).";
      const pages = a.instructions.map((h, i) => `--- page ${i + 1} ---\n${htmlToText(h)}`).join("\n\n");
      const score = a.score ? `Score: ${a.score.percent}% (${a.score.correct}/${a.score.items} items)` : `Score not readable: ${a.scoreError}`;
      return `${score}\n\n${pages}`;
    } },

  { name: "recpt_notes", description: "Text notes/labels placed on the canvas with their positions (labs often write the addressing plan, e.g. '10.0.0.0/8', next to links). Compare positions with recpt_topology device coordinates to see which link a label belongs to.",
    inputSchema: S({}), run: async () => {
      const [notes, topo] = await Promise.all([rpc("notes"), rpc("topology")]);
      const near = (n) => { let best = null, bd = 1e9; for (const d of topo.devices) { const dd = Math.hypot(d.x - n.x, d.y - n.y); if (dd < bd) { bd = dd; best = d.name; } } return best; };
      const vis = notes.filter((n) => n.text.trim());
      return vis.length ? vis.map((n) => `(${n.x},${n.y}) near ${near(n)}: ${n.text.replace(/\s+/g, " ").trim()}`).join("\n") : "No canvas notes.";
    } },

  { name: "recpt_device", description: "Details of one device: model, kind (ios/host), power, hostname, every port with IP/mask/up/linked, gateway/DNS for hosts.",
    inputSchema: S({ device: str("PT device name, e.g. Router0") }, ["device"]),
    run: async ({ device }) => JSON.stringify(await rpc("device", device), null, 2) },

  { name: "recpt_exec", description: "Run commands on a device console and return the transcript. IOS devices: exec-mode commands (show …, enable, ping …); the console is moved past the setup dialog automatically. PCs/servers: Command Prompt (ipconfig, ping, tracert, …). Waits for slow commands like ping.",
    inputSchema: S({ device: str("PT device name"), commands: strs("commands in order"), timeout_ms: { type: "number", description: "max wait for slow output, default 20000" } }, ["device", "commands"]),
    run: async ({ device, commands, timeout_ms }) => {
      const info = await rpc("device", device);
      let pre = [];
      if (info.kind === "ios") {
        const st = await rpc("ready", device);
        if (/\(config/.test(st.prompt)) pre = ["end"]; // exec commands don't work in config mode
      }
      const r = await exec(device, pre.concat(commands), timeout_ms);
      return r.output + (r.pending ? "\n[still running — call recpt_exec again with an empty command to read more]" : "");
    } },

  { name: "recpt_configure", description: "Apply IOS configuration on a router/switch: enters 'configure terminal', runs the lines (indentation not needed; use 'interface X' then sub-commands), then 'end'. Returns the transcript so you can spot '% Invalid input' errors.",
    inputSchema: S({ device: str("PT device name"), lines: strs("config lines, e.g. ['hostname R1','interface g0/0','ip address 10.0.0.1 255.255.255.0','no shutdown']") }, ["device", "lines"]),
    run: async ({ device, lines }) => (await rpc("configure", device, lines)).output },

  { name: "recpt_running_config", description: "Show the running-config of a router/switch.",
    inputSchema: S({ device: str("PT device name") }, ["device"]), run: async ({ device }) => rpc("runningConfig", device) },

  { name: "recpt_save_config", description: "copy running-config startup-config on a router/switch.",
    inputSchema: S({ device: str("PT device name") }, ["device"]), run: async ({ device }) => rpc("saveConfig", device) },

  { name: "recpt_set_host_ip", description: "Set IP configuration of a PC/laptop/server (PT Desktop > IP Configuration). Use dhcp:true for DHCP.",
    inputSchema: S({ device: str("PT device name"), ip: str("IPv4 address"), mask: str("subnet mask, default 255.255.255.0"), gateway: str("default gateway"), dns: str("DNS server"), dhcp: { type: "boolean" }, port: str("port, default FastEthernet0") }, ["device"]),
    run: async (a) => { await rpc("hostIp", a.device, { ip: a.ip, mask: a.mask, gateway: a.gateway, dns: a.dns, dhcp: a.dhcp, port: a.port }); return JSON.stringify((await rpc("device", a.device)).ports[0]); } },

  { name: "recpt_add_device", description: "Add a device to the logical workspace. type: router|switch|multilayerswitch|pc|laptop|server|hub|accesspoint|cloud…; model: PT model, e.g. 1941, 2911, ISR4331, 2960-24TT, 3560-24PS, PC-PT, Laptop-PT, Server-PT. Returns the new device name.",
    inputSchema: S({ type: str("device type"), model: str("PT model name"), x: { type: "number" }, y: { type: "number" } }, ["type", "model"]),
    run: async ({ type, model, x, y }) => { const n = await rpc("addDevice", type, model, x ?? 200, y ?? 200); if (!n) throw new Error(`PT did not create ${type} ${model} (unknown model name?)`); return n; } },

  { name: "recpt_remove_device", description: "Delete a device.", inputSchema: S({ device: str("PT device name") }, ["device"]),
    run: async ({ device }) => (await rpc("removeDevice", device), `removed ${device}`) },

  { name: "recpt_link", description: "Cable two ports. cable: auto (default: picks straight/cross/serial/console/fiber), straight, cross, serial, console, fiber.",
    inputSchema: S({ device_a: str("device"), port_a: str("full port name, e.g. GigabitEthernet0/0"), device_b: str("device"), port_b: str("full port name"), cable: str("cable type, default auto") }, ["device_a", "port_a", "device_b", "port_b"]),
    run: async (a) => (await rpc("link", a.device_a, a.port_a, a.device_b, a.port_b, a.cable || "auto"), "linked") },

  { name: "recpt_unlink", description: "Remove the cable on a port.", inputSchema: S({ device: str("device"), port: str("port") }, ["device", "port"]),
    run: async ({ device, port }) => (await rpc("unlink", device, port), "unlinked") },

  { name: "recpt_power", description: "Turn a device on or off (needed e.g. before adding modules).", inputSchema: S({ device: str("device"), on: { type: "boolean" } }, ["device", "on"]),
    run: async ({ device, on }) => (await rpc("power", device, on), `${device} power ${on ? "on" : "off"}`) },

  { name: "recpt_file", description: "File operations in Packet Tracer: open <path>, save, save_as <path>, new.",
    inputSchema: S({ action: { type: "string", enum: ["open", "save", "save_as", "new"] }, path: str("absolute path for open/save_as") }, ["action"]),
    run: async ({ action, path: p }) => {
      if (action === "open") return String(await rpc("open", p));
      if (action === "save") return String(await rpc("save"));
      if (action === "save_as") return String(await rpc("saveAs", p));
      return String(await rpc("newFile"));
    } },
];

const INSTRUCTIONS = `reCPT drives a live Cisco Packet Tracer instance.
Workflow for exercises: recpt_status -> recpt_activity (read the task) -> recpt_topology + recpt_notes (addressing plan) -> configure with recpt_configure (routers/switches) and recpt_set_host_ip (PCs) -> verify with recpt_exec (show ip interface brief, show ip route, ping) -> recpt_activity for the score (often password-locked by PT; then verify with pings between all end devices) -> recpt_file save only when the user asks.
Device names are PT names from recpt_topology (not IOS hostnames). Check every transcript for '% Invalid input' / '% Incomplete command'.`;

// ---------------------------------------------------------------- MCP stdio plumbing
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return; // notification
  const reply = (result) => send({ jsonrpc: "2.0", id: m.id, result });
  const fail = (code, message) => send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
  try {
    if (m.method === "initialize") return reply({
      protocolVersion: m.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: "recpt", version: "0.2.0" }, instructions: INSTRUCTIONS });
    if (m.method === "ping") return reply({});
    if (m.method === "tools/list") return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (m.method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${m.params?.name}`);
      try {
        const out = await tool.run(m.params.arguments || {});
        return reply({ content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: "Error: " + e.message }], isError: true });
      }
    }
    return fail(-32601, `method not found: ${m.method}`);
  } catch (e) { fail(-32603, e.message); }
});
