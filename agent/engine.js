// reCPT agent — Script Engine file for the PT Script Module "reCPT bridge" (com.ptbridge.agent).
// Runs inside Packet Tracer with direct, synchronous IPC access.
//
// Transport (proven against PT 9.0.1):
//   * PT does not expose $seev/$se to custom-interface pages here, so the page can't call us.
//   * Instead this engine injects BRIDGE_JS into a web view. The page only owns a WebSocket
//     to the local daemon and queues inbound requests.
//   * The engine polls the page (evaluateToVariant -> "javascriptDone" event), runs each
//     request with full IPC access, and sends replies/events back via __ptbSend().

// Keep live transport state when engine.js is hot-reloaded (pt reload).
var PTB = (typeof PTB !== "undefined" && PTB && PTB.view) ? PTB : {
  view: null, watched: {}, pollId: null, lastPoll: 0, state: "", injected: false,
  debugVisible: false,        // true = keep the bridge web view on screen (debugging)
  pollMs: 25,
  port: 39150
};

var DEVICE_TYPES = {
  router: 0, switch: 1, cloud: 2, bridge: 3, hub: 4, repeater: 5, accesspoint: 7, pc: 8,
  server: 9, printer: 10, wirelessrouter: 11, ipphone: 12, dslmodem: 13, cablemodem: 14,
  multilayerswitch: 16, laptop: 18, tablet: 19, pda: 20, tv: 23, analogphone: 25, asa: 27,
  homegateway: 29, celltower: 31, wlc: 41, sniffer: 35, networkcontroller: 50
};
var CABLE_TYPES = {
  straight: 8100, cross: 8101, rollover: 8102, fiber: 8103, phone: 8104, coax: 8110,
  serial: 8106, auto: 8107, console: 8108, wireless: 8109, octal: 8111, usb: 8113, fibermm: 8117
};

// Code injected into the web view. Kept as plain strings (no Function#toString tricks).
function bridgeJs() {
  return [
    "(function(){",
    " if (window.__ptb) return 'already';",
    " var B = window.__ptb = { inbox: [], ws: null, state: 'init', err: '' };",
    " function connect(){",
    "  B.state = 'connecting';",
    "  try { B.ws = new WebSocket('ws://127.0.0.1:" + PTB.port + "/agent'); }",
    "  catch (e) { B.state = 'error'; B.err = String(e); setTimeout(connect, 2000); return; }",
    "  B.ws.onopen = function(){ B.state = 'open'; B.err = '';",
    "    B.ws.send(JSON.stringify({ hello: 'agent', ua: navigator.userAgent, origin: String(location.href) })); };",
    "  B.ws.onmessage = function(e){ B.inbox.push(e.data); };",
    "  B.ws.onclose = function(e){ B.state = 'closed:' + e.code; setTimeout(connect, 1000); };",
    "  B.ws.onerror = function(){ B.err = 'websocket error'; };",
    " }",
    " window.__ptbTake = function(){ var m = B.inbox.splice(0, B.inbox.length);",
    "   return JSON.stringify({ s: B.state, e: B.err, m: m }); };",
    " window.__ptbSend = function(s){ if (B.ws && B.ws.readyState === 1) B.ws.send(s); };",
    " connect();",
    " return 'injected';",
    "})()"
  ].join("\n");
}

function main() {
  var wvm = ipc.appWindow().getWebViewManager();
  PTB.view = wvm.createWebView("reCPT bridge", "this-sm:bridge.htm", 320, 120);
  PTB.view.show();                       // load once…
  if (!PTB.debugVisible) PTB.view.hide(); // …then get out of the way
  PTB.view.registerEvent("javascriptDone", null, onJsDone);
  watchWorkspace();
  dprint("reCPT agent started");
  setTimeout(inject, 300);
  setTimeout(poll, 600);
  setTimeout(watchdog, 2000);
}

function cleanUp() {
  for (var dev in PTB.watched) unwatchTerm(dev);
  if (PTB.view) { PTB.view.close(); PTB.view = null; }
}

function inject() {
  if (!PTB.view) return;
  PTB.view.evaluateJavaScriptAsync(bridgeJs());
  PTB.injected = true;
}

function poll() {
  if (!PTB.view) return;
  PTB.lastPoll = Date.now();
  PTB.pollId = String(PTB.view.evaluateToVariant("window.__ptbTake ? __ptbTake() : 'NOBRIDGE'"));
}

// Re-arm polling if a javascriptDone never arrived (page reload, etc.).
function watchdog() {
  if (!PTB.view) return;
  if (Date.now() - PTB.lastPoll > 2000) { PTB.pollId = null; poll(); }
  setTimeout(watchdog, 2000);
}

function onJsDone(src, args) {
  if (String(args.id) !== PTB.pollId) return; // replies to our sends / other evals
  PTB.pollId = null;
  var raw = String(args.result);
  if (raw === "NOBRIDGE" || raw === "" || raw === "undefined") {
    inject();
  } else {
    var st;
    try { st = JSON.parse(raw); } catch (e) { st = null; }
    if (st) {
      var label = st.s + (st.e ? " (" + st.e + ")" : "");
      if (label !== PTB.state) { PTB.state = label; dprint("bridge: " + label); }
      for (var i = 0; i < st.m.length; i++) handleMessage(st.m[i]);
    }
  }
  setTimeout(poll, PTB.pollMs);
}

function handleMessage(text) {
  var m;
  try { m = JSON.parse(text); } catch (e) { return; }
  if (m.op !== "eval") return;
  var res = JSON.parse(ptbRun(m.code));
  res.id = m.id;
  send(res);
}

function send(obj) {
  if (!PTB.view) return;
  PTB.view.evaluateJavaScriptAsync("window.__ptbSend && __ptbSend(" + JSON.stringify(JSON.stringify(obj)) + ")");
}

// Evaluates `code` in this engine and returns a JSON string {ok, result|error}.
function ptbRun(code) {
  try {
    var r = (0, eval)(code);
    return JSON.stringify({ ok: true, result: r === undefined ? null : r });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

// Push an event out to the daemon (fan-out to CLI / UI clients).
function ptbEmit(obj) { send(obj); }

// Tell clients when the logical topology changes so they can refetch.
function watchWorkspace() {
  var names = ["deviceAdded", "deviceRemoved", "linkCreated", "linkDeleted"];
  safe(function () {
    var ws = lw();
    names.forEach(function (ev) {
      safe(function () {
        ws.registerEvent(ev, null, function (src, args) { ptbEmit({ event: "topology", change: ev }); });
      }, null);
    });
    ipc.appWindow().registerEvent("fileOpened", null, function () { ptbEmit({ event: "topology", change: "fileOpened" }); });
    ipc.appWindow().registerEvent("fileNewed", null, function () { ptbEmit({ event: "topology", change: "fileNewed" }); });
  }, null);
}

// ---- helpers -------------------------------------------------------------------------

function lw() { return ipc.appWindow().getActiveWorkspace().getLogicalWorkspace(); }
function dev(name) {
  var d = ipc.network().getDevice(name);
  if (!d) throw new Error("no device named " + name);
  return d;
}
function safe(f, dflt) { try { return f(); } catch (e) { return dflt; } }

function portInfo(p) {
  return {
    name: p.getName(),
    up: safe(function () { return p.isPortUp(); }, null),
    protocolUp: safe(function () { return p.isProtocolUp(); }, null),
    ip: safe(function () { return String(p.getIpAddress()); }, null),
    mask: safe(function () { return String(p.getSubnetMask()); }, null),
    mac: safe(function () { return String(p.getMacAddress()); }, null),
    linked: safe(function () { return !!p.getLink(); }, false)
  };
}

// ---- API exposed to the daemon (call as ptb.<name>(...)) ------------------------------

var ptb = {
  ping: function () { return "pong"; },

  info: function () {
    var w = ipc.appWindow();
    var f = safe(function () { return w.getActiveFile(); }, null);
    return {
      version: w.getVersion(),
      file: f ? safe(function () { return f.getSavedFilename(); }, null) : null,
      isActivity: f ? safe(function () { return f.isActivityFile(); }, false) : false,
      mode: w.isSimulationMode() ? "simulation" : "realtime",
      devices: ipc.network().getDeviceCount(),
      links: ipc.network().getLinkCount()
    };
  },

  topology: function () {
    var net = ipc.network(), devices = [], links = [];
    for (var i = 0; i < net.getDeviceCount(); i++) {
      var d = net.getDeviceAt(i), ports = [];
      for (var j = 0; j < d.getPortCount(); j++) ports.push(portInfo(d.getPortAt(j)));
      devices.push({
        name: d.getName(), model: d.getModel(), type: d.getType(), power: d.getPower(),
        x: d.getXCoordinate(), y: d.getYCoordinate(), ports: ports
      });
    }
    for (var k = 0; k < net.getLinkCount(); k++) {
      var l = net.getLinkAt(k);
      var p1 = safe(function () { return l.getPort1(); }, null);
      var p2 = safe(function () { return l.getPort2(); }, null);
      links.push({
        type: l.getConnectionType(),
        a: p1 ? { device: p1.getOwnerDevice().getName(), port: p1.getName() } : null,
        b: p2 ? { device: p2.getOwnerDevice().getName(), port: p2.getName() } : null
      });
    }
    return { devices: devices, links: links };
  },

  addDevice: function (type, model, x, y) {
    var t = typeof type === "number" ? type : DEVICE_TYPES[String(type).toLowerCase()];
    if (t === undefined) throw new Error("unknown device type " + type);
    var name = lw().addDevice(t, model, x || 100, y || 100);
    var d = ipc.network().getDevice(name);
    safe(function () { d.skipBoot(); }, null);
    return name;
  },
  removeDevice: function (name) { lw().removeDevice(name); return true; },
  rename: function (name, newName) { dev(name).setName(newName); return newName; },
  move: function (name, x, y) { dev(name).moveToLocation(x, y); return true; },

  // type: a CABLE_TYPES name, a ConnectType number, or "auto" (PT's AUTO value is rejected
  // by createLink, so we pick the cable PT's own auto-connect tool would).
  link: function (d1, p1, d2, p2, type) {
    var name = String(type || "auto").toLowerCase();
    var t = typeof type === "number" ? type : (name === "auto" ? autoCable(d1, p1, d2, p2) : CABLE_TYPES[name]);
    if (t === undefined) throw new Error("unknown cable type " + type);
    var ok = lw().createLink(d1, p1, d2, p2, t);
    if (!ok) throw new Error("PT refused the link (port busy, wrong cable or wrong port name?)");
    return true;
  },
  unlink: function (d, p) { lw().deleteLink(d, p); return true; },

  // Terminal: stream output of a device's CLI as {event:"term"} messages.
  watchTerm: function (name) {
    if (PTB.watched[name]) return true;
    var tl = dev(name).getCommandLine();
    var cb = function (src, args) {
      var text = null;
      for (var k in args) if (typeof args[k] === "string") { text = args[k]; break; }
      ptbEmit({ event: "term", device: name, data: text, raw: args });
    };
    tl.registerEvent("outputWritten", null, cb);
    PTB.watched[name] = { tl: tl, cb: cb };
    return true;
  },
  unwatchTerm: function (name) { return unwatchTerm(name); },
  cli: function (name, command) {
    ptb.watchTerm(name);
    dev(name).getCommandLine().enterCommand(command);
    return true;
  },
  prompt: function (name) {
    var tl = dev(name).getCommandLine();
    return { prompt: tl.getPrompt(), mode: tl.getMode() };
  },

  // Window / file
  hide: function () { ipc.appWindow().setVisible(false); return true; },
  show: function () { var w = ipc.appWindow(); w.setVisible(true); w.raise(); return true; },
  open: function (path) { return ipc.appWindow().fileOpen(path); },
  newFile: function () { return ipc.appWindow().fileNew(false); },
  save: function () { return ipc.appWindow().fileSave(); },
  saveAs: function (path) { ipc.appWindow().fileSaveAsNoPrompt(path, true); return true; },

  // Activity (.pka) progress — graded by PT itself
  score: function () {
    var f = ipc.appWindow().getActiveFile();
    if (!f || !safe(function () { return f.isActivityFile(); }, false)) return null;
    return {
      percent: f.getPercentageComplete(),
      items: f.getAssessmentItemsCount(),
      correctItems: f.getCorrectAssessmentItemsCount(),
      score: f.getAssessmentScoreCount(),
      correctScore: f.getCorrectAssessmentScoreCount(),
      instructions: f.getInstructionCount()
    };
  },
  instruction: function (i) {
    var f = ipc.appWindow().getActiveFile();
    return f.getInstruction(i || 0);
  }
};

// Switch-like devices are "MDI-X"; hosts/routers are "MDI". Same side -> crossover.
var SWITCH_LIKE = { 1: 1, 3: 1, 4: 1, 5: 1, 7: 1, 16: 1, 17: 1 };
function autoCable(d1, p1, d2, p2) {
  var a = String(p1), b = String(p2);
  if (/serial/i.test(a) && /serial/i.test(b)) return CABLE_TYPES.serial;
  if (/console|rs ?232/i.test(a) || /console|rs ?232/i.test(b)) return CABLE_TYPES.console;
  if (/fiber|^Fi|SFP/i.test(a) && /fiber|^Fi|SFP/i.test(b)) return CABLE_TYPES.fiber;
  var s1 = !!SWITCH_LIKE[dev(d1).getType()], s2 = !!SWITCH_LIKE[dev(d2).getType()];
  return s1 === s2 ? CABLE_TYPES.cross : CABLE_TYPES.straight;
}

function unwatchTerm(name) {
  var w = PTB.watched[name];
  if (!w) return false;
  safe(function () { w.tl.unregisterEvent("outputWritten", null, w.cb); }, null);
  delete PTB.watched[name];
  return true;
}

// ======================================================================================
// v0.2 API: configuration, reliable CLI execution, PCs, activities, files.
// enterCommand() writes its output synchronously, so exec() can return a transcript.
// ======================================================================================

var CONSOLE_TYPES = { 0: 1, 1: 1, 16: 1, 17: 1, 27: 1 };   // IOS devices (router/switch/L3/ASA)
var HOST_TYPES = { 8: 1, 9: 1, 18: 1, 19: 1, 20: 1, 21: 1, 22: 1, 12: 1, 10: 1 }; // pc/server/laptop/…

function captureOutput(tl, fn) {
  var buf = [];
  var cb = function (src, args) {
    for (var k in args) if (typeof args[k] === "string") { buf.push(args[k]); break; }
  };
  tl.registerEvent("outputWritten", null, cb);
  try { fn(); } finally { safe(function () { tl.unregisterEvent("outputWritten", null, cb); }, null); }
  return buf.join("");
}

var MORE = /--More--\s*$/;

function extend(target, src) { for (var k in src) target[k] = src[k]; }

extend(ptb, {
  // Run commands on a device's console and return the full transcript.
  // Pages through --More-- automatically. Output that arrives later (ping, boot) is streamed
  // as {event:"term"}; the daemon's /exec waits for it when `pending` is true.
  exec: function (name, commands) {
    var tl = dev(name).getCommandLine();
    if (!tl) throw new Error(name + " has no command line");
    var cmds = Array.isArray(commands) ? commands : [commands];
    var out = "";
    for (var i = 0; i < cmds.length; i++) {
      out += captureOutput(tl, function () { tl.enterCommand(String(cmds[i])); });
      for (var guard = 0; MORE.test(out) && guard < 500; guard++) {
        out += captureOutput(tl, function () { tl.enterChar(32, 0); });
      }
    }
    var prompt = String(tl.getPrompt() || "");
    var tail = out.replace(/\s+$/, "");
    return { output: out, prompt: prompt, mode: String(tl.getMode() || ""),
             pending: !!prompt && tail.slice(-prompt.trim().length) !== prompt.trim() };
  },

  // Send a raw key: " " (page), "\t" (complete), "\x03" (Ctrl+C), "up"/"down"/"left"/"right".
  key: function (name, k) {
    var tl = dev(name).getCommandLine();
    var arrows = { right: 1, left: 2, up: 3, down: 4 };
    return captureOutput(tl, function () {
      if (arrows[k]) tl.enterChar(0, arrows[k]);
      else tl.enterChar(String(k).charCodeAt(0), 0);
    });
  },

  // Get an IOS device past "initial configuration dialog" / "Press RETURN" into user EXEC.
  ready: function (name) {
    var d = dev(name), tl = d.getCommandLine(), out = "";
    safe(function () { d.skipBoot(); }, null);
    for (var i = 0; i < 6; i++) {
      var p = String(tl.getPrompt() || "");
      if (/yes\/no/i.test(p)) out += captureOutput(tl, function () { tl.enterCommand("no"); });
      else if (/[>#]\s*$/.test(p)) break;
      else out += captureOutput(tl, function () { tl.enterCommand(""); });
    }
    return { prompt: String(tl.getPrompt() || ""), output: out };
  },

  // Enter global config, run commands, leave. Returns transcript.
  configure: function (name, commands) {
    ptb.ready(name);
    var pre = [], p = String(dev(name).getCommandLine().getPrompt() || "");
    if (/>\s*$/.test(p)) pre.push("enable");
    if (!/\(config/.test(p)) pre.push("configure terminal");
    return ptb.exec(name, pre.concat(commands, ["end"]));
  },

  runningConfig: function (name) {
    ptb.ready(name);
    var p = String(dev(name).getCommandLine().getPrompt() || "");
    var cmds = [];
    if (/\(config/.test(p)) cmds.push("end");
    if (/>\s*$/.test(p)) cmds.push("enable");
    cmds.push("show running-config");
    var out = ptb.exec(name, cmds).output;
    var i = out.indexOf("Building configuration");
    return (i >= 0 ? out.slice(i) : out).replace(/ ?--More-- ?/g, "").replace(/\x08+/g, "");
  },

  saveConfig: function (name) { ptb.ready(name); return ptb.exec(name, ["enable", "copy running-config startup-config", ""]).output; },

  // Everything a UI or agent needs to know about one device.
  device: function (name) {
    var d = dev(name), ports = [];
    for (var j = 0; j < d.getPortCount(); j++) {
      var p = d.getPortAt(j), info = portInfo(p);
      info.gateway = safe(function () { return String(p.getDefaultGateway()); }, null);
      info.dhcp = safe(function () { return p.isDhcpClientOn(); }, null);
      info.description = safe(function () { return p.getDescription(); }, null);
      ports.push(info);
    }
    var t = d.getType();
    return {
      name: d.getName(), model: d.getModel(), type: t, power: d.getPower(),
      kind: CONSOLE_TYPES[t] ? "ios" : (HOST_TYPES[t] ? "host" : "other"),
      hostname: safe(function () { return d.getHostName(); }, null),
      gateway: safe(function () { return String(d.getProcess("HostIpProcess").getDefaultGateway()); }, null),
      dns: safe(function () { return String(d.getProcess("DnsClient").getServerIp()); }, null),
      prompt: safe(function () { return String(d.getCommandLine().getPrompt()); }, null),
      ports: ports
    };
  },

  // PC / server / laptop IP settings (Desktop > IP Configuration in PT).
  hostIp: function (name, opts) {
    var d = dev(name), port = d.getPort(opts.port || "FastEthernet0") || d.getPortAt(0);
    if (opts.dhcp) { port.setDhcpClientFlag(true); return true; }
    port.setDhcpClientFlag(false);
    if (opts.ip) port.setIpSubnetMask(opts.ip, opts.mask || "255.255.255.0");
    if (opts.gateway !== undefined && opts.gateway !== null) {
      var gw = String(opts.gateway) || "0.0.0.0";
      safe(function () { d.getProcess("HostIpProcess").setDefaultGateway(gw); }, null);
      safe(function () { port.setDefaultGateway(gw); }, null);
    }
    if (opts.dns !== undefined && opts.dns !== null) {
      var dns = String(opts.dns) || "0.0.0.0";
      safe(function () { d.getProcess("DnsClient").setServerIp(dns); }, null);
      safe(function () { port.setDnsServerIp(dns); }, null);
    }
    return true;
  },

  power: function (name, on) { dev(name).setPower(!!on); return !!on; },

  // Canvas notes/labels: labs often put the addressing plan here.
  notes: function () {
    var w = lw(), ids = safe(function () { return w.getCanvasNoteIds(); }, []) || [], out = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      out.push({ text: String(safe(function () { return w.getCanvasNoteText(id); }, "")),
                 x: safe(function () { return w.getCanvasItemRealX(id); }, null), y: safe(function () { return w.getCanvasItemRealY(id); }, null) });
    }
    return out;
  },

  // Activity (.pka): instructions are readable; the score may need the activity password.
  activity: function () {
    var f = ipc.appWindow().getActiveFile();
    if (!f || !safe(function () { return f.isActivityFile(); }, false)) return { isActivity: false };
    var n = safe(function () { return f.getInstructionCount(); }, 0), pages = [];
    for (var i = 0; i < n; i++) pages.push(String(safe(function () { return f.getInstruction(i); }, "")));
    var score = null, err = null;
    try { score = { percent: f.getPercentageComplete(), items: f.getAssessmentItemsCount(), correct: f.getCorrectAssessmentItemsCount() }; }
    catch (e) { err = String(e && e.message ? e.message : e); }
    return { isActivity: true, instructions: pages, score: score, scoreError: err,
             timeElapsed: safe(function () { return f.getTimeElapsed(); }, null) };
  },

  // Hot reload: re-evaluate engine.js from disk without restarting the module.
  reload: function () {
    var root = (typeof __recpt !== "undefined" && __recpt.root) ? __recpt.root
      : ipc.appWindow().getUserFolder() + "/extensions/reCPT/";
    var saved = PTB;
    (0, eval)(String(ipc.systemFileManager().getFileContents(root + "engine.js")));
    PTB = saved;
    return "reloaded " + Object.keys(ptb).length + " api functions";
  },

  openDialog: function () {
    var p = ipc.systemFileManager().getOpenFileName("Open with reCPT", ipc.appWindow().getUserFolder() + "/saves", "Packet Tracer (*.pkt *.pka)");
    return p ? String(p) : null;
  },
  saveDialog: function () {
    var p = ipc.systemFileManager().getSaveFileName("Save with reCPT", ipc.appWindow().getUserFolder() + "/saves", "Packet Tracer (*.pkt *.pka)");
    return p ? String(p) : null;
  }
});
