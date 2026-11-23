#!/usr/bin/env node
// ptd — ptbridge daemon. Zero dependencies (Node >= 20).
//
//   PT Script Module (bridge.htm) ──ws /agent──▶ ptd ◀──HTTP /rpc, ws /events── CLI, Tauri UI
//
// Listens on 127.0.0.1 only. Clients authenticate with the token in ~/.ptbridge/token.
// The agent endpoint refuses connections that carry a web (http/https) Origin, so a random
// website in your browser can't pose as the agent.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PTB_PORT || 39150);
const HOST = "127.0.0.1";
const DIR = path.join(os.homedir(), ".ptbridge");
const TOKEN_FILE = path.join(DIR, "token");
const RPC_TIMEOUT_MS = Number(process.env.PTB_RPC_TIMEOUT || 15000);
const UI_FILE = fileURLToPath(new URL("../ui/index.html", import.meta.url));

// ---------- token ----------
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch {}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_FILE, TOKEN + "\n", { mode: 0o600 });
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- minimal WebSocket (RFC 6455, text frames) ----------
function wsAccept(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  const conn = { socket, onmessage: null, onclose: null, alive: true, buf: Buffer.alloc(0), frags: [] };
  conn.send = (text) => {
    if (!conn.alive) return;
    const data = Buffer.from(text);
    let header;
    if (data.length < 126) header = Buffer.from([0x81, data.length]);
    else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
    socket.write(Buffer.concat([header, data]));
  };
  const close = () => {
    if (!conn.alive) return;
    conn.alive = false;
    try { socket.end(Buffer.from([0x88, 0])); } catch {}
    conn.onclose && conn.onclose();
  };
  conn.close = close;
  socket.on("data", (chunk) => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    for (;;) {
      const b = conn.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (b.length < need) return;
      let payload = b.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = b.subarray(off, off + 4);
        payload = Buffer.from(payload.map((x, i) => x ^ mask[i & 3]));
      }
      conn.buf = b.subarray(need);
      if (op === 0x8) return close();
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        conn.frags.push(payload);
        if (fin) { const text = Buffer.concat(conn.frags).toString("utf8"); conn.frags = []; conn.onmessage && conn.onmessage(text); }
      }
    }
  });
  socket.on("end", close); // upgraded sockets are half-open; peer FIN means gone
  socket.on("close", close);
  socket.on("error", close);
  return conn;
}

// ---------- state ----------
let agent = null;          // the PT-side connection
let agentHello = null;
const clients = new Set(); // event subscribers
const pending = new Map(); // id -> {resolve, timer}
let nextId = 1;

function broadcast(obj) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  for (const c of clients) c.send(s);
}

function callAgent(code) {
  return new Promise((resolve) => {
    if (!agent) return resolve({ ok: false, error: "agent not connected — is Packet Tracer running with the ptbridge Script Module?" });
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: "timeout waiting for Packet Tracer" }); }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    agent.send(JSON.stringify({ id, op: "eval", code }));
  });
}

// {call:"topology", args:[...]} -> "ptb.topology.apply(ptb, [...])"; {code:"..."} passes through.
function toCode(req) {
  if (typeof req.code === "string") return req.code;
  if (typeof req.call === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(req.call)) {
    return `ptb.${req.call}.apply(ptb, ${JSON.stringify(Array.isArray(req.args) ? req.args : [])})`;
  }
  return null;
}

function authed(req, url) {
  const h = req.headers["authorization"] || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token");
  return !!t && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.method === "GET" && url.pathname === "/status") {
    return json(200, { agent: !!agent, hello: agentHello, clients: clients.size, pending: pending.size });
  }
  // reCPT UI (prototype). Served only on 127.0.0.1; the token is baked into the page so the
  // page can call /rpc and /events. Other websites can't read this response (no CORS).
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = fs.readFileSync(UI_FILE, "utf8").replace("__PTB_TOKEN__", TOKEN);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    } catch (e) { return json(500, { ok: false, error: "ui not found: " + UI_FILE }); }
  }
  if (!authed(req, url)) return json(401, { ok: false, error: "missing or bad token (see ~/.ptbridge/token)" });

  if (req.method === "POST" && url.pathname === "/rpc") {
    let body = "";
    for await (const c of req) { body += c; if (body.length > 1e6) return json(413, { ok: false, error: "too large" }); }
    let parsed; try { parsed = JSON.parse(body); } catch { return json(400, { ok: false, error: "bad json" }); }
    const code = toCode(parsed);
    if (!code) return json(400, { ok: false, error: "need {call,args} or {code}" });
    return json(200, await callAgent(code));
  }
  json(404, { ok: false, error: "not found" });
});

server.on("request", (req) => {
  if (process.env.PTB_VERBOSE || /from=/.test(req.url)) log("http", req.method, req.url, "origin=" + (req.headers.origin || "-"));
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${HOST}`);
  const origin = req.headers["origin"] || "";
  log("upgrade", url.pathname, "origin=" + (origin || "-"), "ua=" + (req.headers["user-agent"] || "-").slice(0, 60));

  if (url.pathname === "/agent") {
    if (/^https?:\/\//i.test(origin)) { log("refused agent with web origin", origin); socket.destroy(); return; }
    const conn = wsAccept(req, socket); if (!conn) return;
    if (agent) agent.close();
    agent = conn;
    log("agent connected", origin ? `(origin ${origin})` : "");
    conn.onmessage = (text) => {
      let m; try { m = JSON.parse(text); } catch { return; }
      if (m.hello) { agentHello = m; log("agent hello", m.ua || ""); broadcast({ event: "agent", connected: true }); return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
        delete m.id; p.resolve(m); return;
      }
      if (m.event) broadcast(m);
    };
    conn.onclose = () => {
      if (agent !== conn) return;
      agent = null; agentHello = null;
      for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, error: "Packet Tracer agent disconnected" }); pending.delete(id); }
      log("agent disconnected"); broadcast({ event: "agent", connected: false });
    };
    return;
  }

  if (url.pathname === "/events") {
    if (!authed(req, url)) { socket.destroy(); return; }
    const conn = wsAccept(req, socket); if (!conn) return;
    clients.add(conn);
    conn.send(JSON.stringify({ event: "agent", connected: !!agent }));
    // Clients may also issue RPCs over the socket: {id, call, args} or {id, code}
    conn.onmessage = async (text) => {
      let m; try { m = JSON.parse(text); } catch { return; }
      const code = toCode(m); if (!code) return;
      const r = await callAgent(code);
      conn.send(JSON.stringify({ ...r, id: m.id }));
    };
    conn.onclose = () => clients.delete(conn);
    return;
  }
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  log(`ptd listening on http://${HOST}:${PORT}  (token: ${TOKEN_FILE})`);
});
