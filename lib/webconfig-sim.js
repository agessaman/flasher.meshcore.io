/* WebConfig portal simulator.
 *
 * Intercepts fetch() so webui/index.html — served verbatim — runs with no
 * device behind it. Loaded before the page's own script, so boot() and every
 * later call hit this instead of the network.
 *
 * Scope is a demo, not the contract harness: scripts/webconfig_mock_server.py
 * stays the thing that mirrors WebConfigServer.cpp precisely. What this must
 * get right is the shape of every response the page consumes, and enough CLI
 * behaviour that `get`/`set` round-trip.
 */
(function () {
  "use strict";

  var SENTINEL = "********";
  var MAX_CMDS = 24;            // MAX_BATCH in WebConfigServer.h
  var CLI_PAGE = 8;             // WebConfigBatch::kCliResultPage

  var cfg = {
    radio: {
      freq: 910.525, bw: 62.5, sf: 7, cr: 5, tx: 22, af: 1, rxdelay: 0,
      txdelay: 0.5, cad: false, rxgain: true, repeat: true, flood_max: 64,
      flood_max_advert: 8, flood_max_unscoped: 8, loop_detect: "moderate",
      name: "Lookout Mtn Repeater", lat: 39.7392, lon: -105.2405,
      advert_interval: 240, flood_advert_interval: 6
    },
    wifi: { ssid: "Summit-WiFi", pwd: "hunter2hunter2", powersave: "min" },
    mqtt: {
      origin: "Lookout Mtn Repeater", iata: "DEN", status: true, packets: true,
      raw: false, tx: "advert", rx: true, interval: 5,
      timezone: "MST7MDT,M3.2.0,M11.1.0", timezone_offset: -7,
      ntp: "pool.ntp.org", owner: "", email: "ops@example.org", snmp: false,
      snmp_community: "public", neighbors: true, neighbors_interval: 24,
      slots: []
    },
    cli: {
      "radio.watchdog": 0, "int.thresh": 0, "agc.reset.interval": 0,
      "direct.txdelay": 0, "multi.acks": 0, "allow.read.only": false,
      "path.hash.mode": 0, "owner.info": "", "guest.password": "",
      "adc.multiplier": 1, alert: false, "alert.psk": "", "alert.hashtag": "",
      "alert.region": "", "alert.interval": 15, "alert.mqtt": false,
      "alert.wifi": false, "bridge.enabled": false, "bridge.source": "rx",
      "bridge.baud": 115200, "bridge.delay": 0, "bridge.channel": 0,
      "bridge.secret": ""
    }
  };
  for (var i = 0; i < 6; i++) {
    cfg.mqtt.slots.push({ preset: "none", server: "", port: 8883, username: "",
      password: "", token: "", topic: "", audience: "", filter: "all" });
  }
  ["analyzer-us", "cascadiamesh", "waev"].forEach(function (n, idx) {
    cfg.mqtt.slots[idx].preset = n;
  });

  var PRESETS = ["analyzer-us", "analyzer-eu", "nz-analyzer", "meshmapper", "waev",
    "meshomatic", "cascadiamesh", "tennmesh", "nashmesh", "ctmesh", "chimesh",
    "meshat.se", "eastidahomesh", "coloradomesh", "dutchmeshcore-1",
    "dutchmeshcore-2", "meshcore-ca-1", "meshcore-ca-2", "meshcore-fi",
    "bostonmesh", "rflab", "ipnt.uk", "flmesh", "corecomms"]
    .map(function (n) { return { name: n, needs: "none" }; })
    .concat([{ name: "meshrank", needs: "token" }, { name: "inwmesh", needs: "userpass" }]);

  var SETUP = /[?&]setup\b/.test(location.search);
  var started = Date.now();
  // Persisted so the session survives a reload, the way a cookie does on the
  // device — otherwise the demo drops back to the login screen unexpectedly.
  // The demo lands on the panel, not on a password prompt — the login screen is
  // not what anyone came to see. ?login shows it; the page's prose covers it.
  var LOGIN_DEMO = /[?&]login\b/.test(location.search);
  var authed = SETUP || (!LOGIN_DEMO && sessionStorage.getItem("wcsim.authed") !== "0")
    || sessionStorage.getItem("wcsim.authed") === "1";
  function setAuthed(v) {
    authed = v;
    try { sessionStorage.setItem("wcsim.authed", v ? "1" : "0"); } catch (e) {}
  }
  var uptime = function () { return 4 * 3600 + Math.floor((Date.now() - started) / 1000); };

  /* -------------------------------------------------- config key plumbing */
  var BOOL = { cad: ["radio", "cad"], "radio.rxgain": ["radio", "rxgain"],
    repeat: ["radio", "repeat"], "mqtt.status": ["mqtt", "status"],
    "mqtt.packets": ["mqtt", "packets"], "mqtt.raw": ["mqtt", "raw"],
    "mqtt.rx": ["mqtt", "rx"], snmp: ["mqtt", "snmp"],
    "mqtt.neighbors": ["mqtt", "neighbors"] };
  var INT = { tx: ["radio", "tx"], "flood.max": ["radio", "flood_max"],
    "flood.max.advert": ["radio", "flood_max_advert"],
    "flood.max.unscoped": ["radio", "flood_max_unscoped"],
    "advert.interval": ["radio", "advert_interval"],
    "flood.advert.interval": ["radio", "flood_advert_interval"],
    "mqtt.interval": ["mqtt", "interval"],
    "mqtt.neighbors.interval": ["mqtt", "neighbors_interval"],
    "timezone.offset": ["mqtt", "timezone_offset"] };
  var FLT = { lat: ["radio", "lat"], lon: ["radio", "lon"], af: ["radio", "af"],
    rxdelay: ["radio", "rxdelay"], txdelay: ["radio", "txdelay"] };
  var STR = { name: ["radio", "name"], "wifi.ssid": ["wifi", "ssid"],
    "wifi.powersave": ["wifi", "powersave"], "loop.detect": ["radio", "loop_detect"],
    "mqtt.origin": ["mqtt", "origin"], "mqtt.ntp": ["mqtt", "ntp"],
    "mqtt.email": ["mqtt", "email"], timezone: ["mqtt", "timezone"],
    "snmp.community": ["mqtt", "snmp_community"], "mqtt.tx": ["mqtt", "tx"] };
  var SECRET = { "wifi.pwd": ["wifi", "pwd"] };
  Object.keys(cfg.cli).forEach(function (k) {
    var v = cfg.cli[k];
    var t = typeof v === "boolean" ? BOOL : typeof v === "number"
      ? (String(v).indexOf(".") < 0 ? INT : FLT) : STR;
    t[k] = ["cli", k];
  });
  ["guest.password", "alert.psk", "bridge.secret"].forEach(function (k) {
    SECRET[k] = ["cli", k]; delete STR[k];
  });

  function isSecretKey(k) {
    return SECRET.hasOwnProperty(k) || /^mqtt[1-6]\.(password|token)$/.test(k);
  }
  function readKey(k) {
    var m = /^mqtt([1-6])\.(\w+)$/.exec(k);
    if (m) { var s = cfg.mqtt.slots[+m[1] - 1]; return s && k in s ? s[m[2]] : s ? s[m[2]] : undefined; }
    var t = [BOOL, INT, FLT, STR, SECRET];
    for (var i = 0; i < t.length; i++) {
      if (t[i].hasOwnProperty(k)) {
        var p = t[i][k], v = cfg[p[0]][p[1]];
        return t[i] === BOOL ? (v ? "on" : "off") : v;
      }
    }
    var r = cfg.radio;
    return ({ radio: r.freq.toFixed(3) + "," + r.bw.toFixed(2) + "," + r.sf + "," + r.cr,
      freq: r.freq, bw: r.bw, sf: r.sf, cr: r.cr, "mqtt.iata": cfg.mqtt.iata,
      "mqtt.owner": cfg.mqtt.owner, role: "Repeater",
      dutycycle: (100 / (r.af + 1)).toFixed(1) })[k];
  }
  function applySet(key, val) {
    if (key === "password") return [true, "OK"];
    if (key === "radio.fem.rxgain") return [false, "Error: unsupported"];
    if (key === "dutycycle") { cfg.radio.af = 100 / parseFloat(val) - 1; return [true, "OK"]; }
    if (key === "radio") {
      var p = String(val).split(",");
      if (p.length !== 4) return [false, "Error, invalid radio params"];
      cfg.radio.freq = +p[0]; cfg.radio.bw = +p[1]; cfg.radio.sf = +p[2]; cfg.radio.cr = +p[3];
      return [true, "OK - reboot to apply"];
    }
    if (key === "mqtt.iata") {
      if (!/^[A-Za-z0-9]{3}$/.test(val)) return [false, "Error: IATA code must be exactly 3 letters/digits (e.g. DEN)"];
      cfg.mqtt.iata = val.toUpperCase(); return [true, "OK"];
    }
    var m = /^mqtt([1-6])\.(\w+)$/.exec(key);
    if (m) {
      var slot = cfg.mqtt.slots[+m[1] - 1], f = m[2];
      if (!(f in slot)) return [false, "Error: unknown slot field"];
      slot[f] = f === "port" ? parseInt(val, 10) : val;
      return [true, f === "preset" ? "OK - slot " + m[1] + " preset: " + val : "OK"];
    }
    if (BOOL[key]) { var b = BOOL[key]; cfg[b[0]][b[1]] = val === "on"; return [true, "OK"]; }
    if (INT[key]) { var n = INT[key]; cfg[n[0]][n[1]] = parseInt(val, 10); return [true, "OK"]; }
    if (FLT[key]) { var g = FLT[key]; cfg[g[0]][g[1]] = parseFloat(val); return [true, "OK"]; }
    if (SECRET[key]) { var q = SECRET[key]; cfg[q[0]][q[1]] = val; return [true, "OK"]; }
    if (STR[key]) { var t = STR[key]; cfg[t[0]][t[1]] = val; return [true, "OK"]; }
    return [false, "unknown config: " + key];
  }

  /* ------------------------------------------------------------------ CLI */
  function slotStatus() {
    return cfg.mqtt.slots.slice(0, 5).map(function (s, i) {
      return s.preset === "none" ? "slot " + (i + 1) + ": unconfigured"
        : "slot " + (i + 1) + ": " + s.preset + "  connected  tx=" + (900 + i * 137) + " err=0";
    }).join("\n");
  }
  var VERBS = {
    ver: function () { return "v1.16.0.5-observer-beta-dev-a1b2c3d (Build: 6 Jun 2026)"; },
    board: function () { return "Heltec V4 OLED"; },
    clock: function () { return new Date().toUTCString(); },
    memory: function () { return "Free: 142832, Min: 126808, Max: 131060, Queue: 0, IntFree: 142428, PSRAM: 1888451/2097151"; },
    neighbors: function () { return "d4e5f60718  -71 dBm  snr 9.5   2m ago\n1122334455  -94 dBm  snr 2.0  14m ago"; },
    advert: function () { return "OK - Advert sent"; },
    "discover.neighbors": function () { return "OK - Discover sent"; },
    "clear stats": function () { return "OK - stats cleared"; },
    region: function () { return "US915"; },
    powersaving: function () { return "off"; },
    "sensor list": function () { return "0: battery (mV)\n1: temperature (C)"; },
    reboot: function () { return "OK - reboot queued"; }
  };
  var UNAVAILABLE = [
    ["start ota", "start ota needs port 80, which this portal is using. Run it from the serial console, or use `ota update`."],
    ["clock sync", "clock sync takes its time from the caller, which a web request has no way to supply. Use `time <epoch-seconds>` instead."],
    ["log", "log writes the packet log to the serial console, not here, and blocks the radio while it does. Use `log start` / `log stop`."],
    ["get acl", "get acl writes to the serial console, not here."]
  ];
  function unavailable(cmd) {
    for (var i = 0; i < UNAVAILABLE.length; i++) {
      var t = UNAVAILABLE[i][0];
      if (t === "log" || t === "get acl" ? cmd === t : cmd.indexOf(t) === 0) return UNAVAILABLE[i][1];
    }
    return null;
  }
  function secretRead(cmd) {
    if (cmd.indexOf("get ") !== 0) return false;
    var k = cmd.slice(4).trim();
    return k === "prv.key" || k === "guest.password" || k === "alert.psk" ||
      k === "bridge.secret" || isSecretKey(k);
  }
  function execCli(cmd) {
    if (VERBS[cmd]) return VERBS[cmd]();
    if (cmd.indexOf("get ") === 0) {
      var k = cmd.slice(4).trim();
      if (k === "mqtt.status") return "> " + slotStatus();
      if (k === "mqtt.presets") return "> " + PRESETS.map(function (p, i) { return (i + 1) + ". " + p.name; }).join("\n");
      if (k === "wifi.status") return "> SSID: " + cfg.wifi.ssid + "\nIP: 192.168.1.42\nRSSI: -58 dBm";
      if (k === "mqtt.stats") return "> Free=142144 Max=131060 q:0/50 Outbox=0 drops=0/0";
      var v = readKey(k);
      return v === undefined ? "??: " + k : "> " + v;
    }
    if (cmd.indexOf("set ") === 0) {
      var rest = cmd.slice(4).trim(), sp = rest.indexOf(" ");
      var key = sp < 0 ? rest : rest.slice(0, sp);
      return applySet(key, sp < 0 ? "" : rest.slice(sp + 1).trim())[1];
    }
    if (cmd.indexOf("password ") === 0) return "OK";
    if (cmd.indexOf("stats-") === 0) return "recv=51204 sent=8817 rx_err=3 airtime=41s";
    return "Unknown command";
  }

  var job = null;
  function startJob(reqid, cmds) {
    job = { reqid: reqid, cmds: cmds, results: [], at: Date.now(), allOk: true,
      reboot: cmds.some(function (c) { return c.indexOf("reboot") === 0; }) };
  }
  function advance() {
    if (!job) return;
    var due = Math.floor((Date.now() - job.at) / 160);
    while (job.results.length < job.cmds.length && job.results.length < due) {
      var cmd = job.cmds[job.results.length];
      var reply = cmd.indexOf("reboot") === 0 ? "OK - reboot queued" : execCli(cmd);
      if (cmd.indexOf("set ") === 0 || cmd.indexOf("password ") === 0) {
        job.allOk = job.allOk && reply.indexOf("OK") === 0;
      }
      if (secretRead(cmd)) {
        var val = reply.indexOf("> ") === 0 ? reply.slice(2) : reply;
        reply = (val === "" || val === "(not set)") ? "> (not set)" : "> ******** (serial only)";
      }
      job.results.push({ ok: !/^(Err|ERR|err|\(ERR|Unknown command|unknown config|\?\?|Can't find)/.test(reply), reply: reply });
    }
  }

  /* --------------------------------------------------------- fetch shim */
  var pendingBatch = null;
  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body),
      { status: status || 200, headers: { "Content-Type": "application/json" } }));
  }
  function maskedConfig() {
    var c = JSON.parse(JSON.stringify(cfg));
    delete c.cli;
    c.wifi.pwd = cfg.wifi.pwd ? SENTINEL : "";
    c.mqtt.slots.forEach(function (s) {
      s.password = s.password ? SENTINEL : ""; s.token = s.token ? SENTINEL : "";
    });
    return c;
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = String(typeof input === "string" ? input : input.url);
    if (url.indexOf("/api/") < 0) return realFetch(input, init);
    var path = url.split("?")[0].replace(/^.*\/api\//, "/api/");
    var q = new URLSearchParams((url.split("?")[1] || ""));
    var body = init && init.body ? JSON.parse(init.body) : {};
    var delay = 120;

    var handler = function () {
      switch (path) {
        case "/api/status":
          return json({ mode: SETUP ? "setup" : "lan", auth: authed,
            needs_setup: SETUP, name: cfg.radio.name, node_id: "a1b2c3d4e5f60718",
            fw: "v1.16.0.5-observer-beta-dev-a1b2c3d", build_date: "6 Jun 2026",
            role: "Repeater", board: "Heltec V4 OLED", uptime_s: uptime(),
            runtime_slots: 6, max_slots: 6, active_slots: 5, max_cmds: MAX_CMDS });
        case "/api/presets":
          return json({ presets: PRESETS });
        case "/api/login":
          if (body.password !== "password") return json({ error: "wrong password" }, 401);
          setAuthed(true); return json({ ok: true });
        case "/api/logout":
          setAuthed(false); return json({ ok: true });
        case "/api/config":
          if (!authed) return json({ error: "auth" }, 401);
          if (!init || init.method !== "POST") return json(maskedConfig());
          var setmap = body.set || {}, results = [], allOk = true;
          Object.keys(setmap).forEach(function (k) {
            if (isSecretKey(k) && setmap[k] === SENTINEL) return;
            var r = applySet(k, String(setmap[k]));
            if (!r[0]) allOk = false;
            results.push({ key: k, reply: r[1] });
          });
          pendingBatch = { reqid: body.reqid, results: results, allOk: allOk,
            reboot: !!body.reboot, at: Date.now() };
          return json({ state: "pending", count: results.length, reqid: body.reqid }, 202);
        case "/api/config/result":
          if (!pendingBatch) return json({ state: "idle", reqid: q.get("reqid") });
          if (pendingBatch.reqid !== q.get("reqid")) return json({ error: "unknown request" }, 404);
          if (Date.now() - pendingBatch.at < 700) return json({ state: "pending", reqid: pendingBatch.reqid });
          return json({ state: "done", reqid: pendingBatch.reqid, all_ok: pendingBatch.allOk,
            reboot: pendingBatch.reboot && pendingBatch.allOk, results: pendingBatch.results });
        case "/api/cli":
          if (!authed) return json({ error: "auth" }, 401);
          var cmds = (body.cmds || []).map(function (c) { return String(c).trim(); })
            .filter(function (c) { return c; });
          if (!cmds.length) return json({ error: "no commands" }, 400);
          if (cmds.length > MAX_CMDS) return json({ error: "too many commands", max: MAX_CMDS }, 413);
          for (var i = 0; i < cmds.length; i++) {
            var why = unavailable(cmds[i]);
            if (why) return json({ error: why }, 400);
          }
          if (job && job.reqid === body.reqid) return json({ state: "running", reqid: body.reqid, total: job.cmds.length }, 202);
          startJob(body.reqid, cmds);
          return json({ state: "running", reqid: body.reqid, total: cmds.length }, 202);
        case "/api/cli/result":
          if (!job) return json({ state: "idle", reqid: q.get("reqid") });
          if (job.reqid !== q.get("reqid")) return json({ error: "unknown request" }, 404);
          advance();
          var from = parseInt(q.get("from") || "0", 10);
          var page = job.results.slice(from, from + CLI_PAGE);
          var done = job.results.length === job.cmds.length && from + page.length >= job.cmds.length;
          var out = { state: done ? "done" : "running", reqid: job.reqid,
            total: job.cmds.length, from: from, results: page };
          if (done) {
            out.all_ok = job.allOk;
            out.reboot = job.reboot && job.allOk;
            if (job.reboot && !job.allOk) out.reboot_withheld = true;
          }
          return json(out);
        case "/api/stats":
          if (!authed) return json({ error: "auth" }, 401);
          var up = uptime();
          return json({ uptime_s: up, batt_mv: 4020, heap_free: 142832, heap_min: 126808,
            heap_max_alloc: 131060, noise: -98, rssi: -71, snr: 9.5,
            airtime_s: Math.floor(up / 20), rx_airtime_s: Math.floor(up / 8),
            recv: 51204, sent: 8817, rx_err: 3, sent_flood: 4021, sent_direct: 4796,
            recv_flood: 30112, recv_direct: 21092, tx_queue: 0, mqtt_queue: 0,
            wifi_rssi: -58, ip: "192.168.1.42",
            slots: cfg.mqtt.slots.slice(0, 5).map(function (s, i) {
              return s.preset === "none" ? null
                : { n: i + 1, name: s.preset, state: "ok", ok: 900 + i * 137, err: 0 };
            }).filter(Boolean) });
        case "/api/scan":
          return json({ state: "done", networks: [
            { ssid: "Summit-WiFi", rssi: -49, enc: true },
            { ssid: "Summit-WiFi-5G", rssi: -58, enc: true },
            { ssid: "Ridge-Guest", rssi: -71, enc: false },
            { ssid: "CenturyLink7734", rssi: -84, enc: true }] });
        case "/api/reboot":
          return json({ ok: true });
        case "/api/portal/exit":
          return json({ ok: true, url: location.href });
      }
      return json({ error: "not found" }, 404);
    };
    return new Promise(function (res) { setTimeout(function () { res(handler()); }, delay); });
  };

  /* ------------------------------------------------- host page interface
   * The docs page frames this in a phone/desktop surround and shows tips
   * beside it. It needs to know which tab the visitor is on, and to be able
   * to stage a demo ("paste a config") without the visitor typing it out.
   * Same-origin would allow reaching into the document directly; messages
   * keep the coupling to one named, greppable surface instead.
   */
  function post(msg) {
    if (window.parent !== window) window.parent.postMessage(Object.assign({ wcsim: true }, msg), "*");
  }

  function currentTab() {
    function visible(sel) {
      var el = document.querySelector(sel);
      return el && !el.classList.contains("hide");
    }
    if (visible("#v-wizard")) return "wizard";
    if (visible("#v-login")) return "login";
    if (!visible("#v-app")) return null;   // still booting: no view to report yet
    var on = document.querySelector("#tabs button.on");
    return on ? on.dataset.t : null;
  }

  // Watch for the change rather than listening for the click. The portal
  // registers its own #tabs handler at script-eval time and this file is
  // injected ahead of it, so a click listener here runs FIRST and reads the tab
  // on its way out. A timer would dodge that but browsers throttle timers in
  // iframes that are not the foreground tab, which makes the tips lag by
  // seconds. An observer fires after the class actually changes, in both cases.
  var lastView = null;
  function announce(force) {
    var v = currentTab();
    if (!force && v === lastView) return;
    lastView = v;
    post({ type: "view", view: v });
  }
  function watchViews() {
    var obs = new MutationObserver(function () { announce(); });
    var opts = { subtree: true, attributes: true, attributeFilter: ["class"] };
    ["#tabs", "#v-login", "#v-wizard", "#v-app"].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) obs.observe(el, opts);
    });
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.wcsim !== "action") return;
    var input = document.querySelector("#term-in");
    switch (d.action) {
      case "tab": {
        var b = document.querySelector('#tabs button[data-t="' + d.tab + '"]');
        if (b) b.click();
        break;
      }
      case "run":
        if (input && typeof cliSubmit === "function") {
          document.querySelector('#tabs button[data-t="cli"]').click();
          input.value = d.cmd;
          cliSubmit();
        }
        break;
      case "type":
        if (input) {
          document.querySelector('#tabs button[data-t="cli"]').click();
          input.value = d.cmd;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.focus();
        }
        break;
      case "paste":
        if (input) {
          document.querySelector('#tabs button[data-t="cli"]').click();
          input.focus();
          var dt = new DataTransfer();
          dt.setData("text/plain", d.text);
          input.dispatchEvent(new ClipboardEvent("paste",
            { clipboardData: dt, bubbles: true, cancelable: true }));
        }
        break;
      case "reset":
        try { sessionStorage.removeItem("wcsim.authed"); } catch (e) {}
        location.replace(location.pathname + (d.setup ? "?setup" : ""));
        break;
    }
  });

  // Not DOMContentLoaded: this script is injected into a page whose own script
  // is the last thing in the body, and in an iframe it can execute after the
  // event has already fired — leaving the tab listener unattached and the tips
  // rail silently stuck on whatever it showed first.
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  ready(function () {
    var note = document.createElement("div");
    note.id = "sim-note";
    note.textContent = "Simulator — nothing here reaches a real node.";
    document.body.appendChild(note);
    watchViews();
    announce(true);
    post({ type: "ready" });
  });
})();
