// reCPT agent — Script Engine file for the PT Script Module "reCPT bridge" (com.ptbridge.agent).
// Runs inside Packet Tracer with direct, synchronous IPC access.
//
// Transport (proven against PT 9.0.1):
//   * PT does not expose $seev/$se to custom-interface pages here, so the page can't call us.
//   * Instead this engine injects BRIDGE_JS into a web view. The page only owns a WebSocket
//     to the local daemon and queues inbound requests.
//   * The engine polls the page (evaluateToVariant -> "javascriptDone" event), runs each
//     request with full IPC access, and sends replies/events back via __ptbSend().

var PTB = {
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
