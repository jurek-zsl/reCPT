// reCPT loader — the ONLY code baked into agent/reCPT.pts (Script Engine file "main.js").
// It never changes between releases: at start it loads the real agent from
//   <PT user folder>/extensions/reCPT/engine.js
// which the installer (setup/install.mjs) copies there. Updating reCPT = replacing that file.
var __recpt = { root: ipc.appWindow().getUserFolder() + "/extensions/reCPT/" };
(function () {
  var fm = ipc.systemFileManager(), file = __recpt.root + "engine.js";
  if (!fm.fileExists(file)) {
    dprint("reCPT: " + file + " not found. Run the reCPT installer.");
    main = function () {}; cleanUp = function () {};
    return;
  }
  (0, eval)(String(fm.getFileContents(file))); // defines main(), cleanUp(), ptb, …
})();
