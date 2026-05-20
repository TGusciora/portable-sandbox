#!/usr/bin/env node
// Services control plane. Runs inside the services container as root so it
// can do tools_install. Child processes (the actual dev servers) are spawned
// as uid 1000 (agent) so files in /workspace stay agent-owned.
//
// The agent talks to this server over HTTP, naming services that are declared
// in /services/config.json — same trust model as the broker. Unknown names
// are rejected; the agent never sees secret values.

import { spawn, spawnSync } from "node:child_process";
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const HOST = process.env.SERVICES_HOST || "0.0.0.0";
const PORT = Number(process.env.SERVICES_PORT || "9999");
const CONFIG_PATH = process.env.SERVICES_CONFIG || "/services/config.json";
const LOG_DIR = process.env.SERVICES_LOG_DIR || "/var/log/services";
const RUN_UID = Number(process.env.SERVICES_RUN_UID || "1000");
const RUN_GID = Number(process.env.SERVICES_RUN_GID || "1000");
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

mkdirSync(LOG_DIR, { recursive: true });
spawnSync("chown", ["-R", `${RUN_UID}:${RUN_GID}`, LOG_DIR], { stdio: "ignore" });

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (ENV_NAME_PATTERN.test(key)) out[key] = value;
  }
  return out;
}

function loadSecretStore(config) {
  const store = {};
  for (const [name, filePath] of Object.entries(config.secrets || {})) {
    try {
      const parsed = parseEnvFile(readFileSync(filePath, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        store[k] = { value: v, source: name };
      }
    } catch (err) {
      console.error(`[services] failed to read secret file ${filePath} (${name}): ${err.message}`);
    }
  }
  return store;
}

function selectSecrets(requested, store) {
  const env = {};
  if (!Array.isArray(requested)) return env;
  const wanted = new Set(requested);
  for (const [k, { value, source }] of Object.entries(store)) {
    if (wanted.has(source)) env[k] = value;
  }
  return env;
}

// ---------- tools_install ----------

function runToolsInstall(config) {
  const tools = config.tools_install || [];
  if (tools.length === 0) return;
  console.log(`[services] tools_install: ${tools.length} entr${tools.length === 1 ? "y" : "ies"}`);
  for (const tool of tools) {
    if (tool.check && tool.check.length > 0) {
      const r = spawnSync(tool.check[0], tool.check.slice(1), { stdio: "ignore" });
      if (r.status === 0) {
        console.log(`[services] tools_install: ${tool.name} already present, skipping`);
        continue;
      }
    }
    for (const cmd of tool.install) {
      console.log(`[services] tools_install: ${tool.name}: ${cmd.join(" ")}`);
      const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
      if (r.status !== 0) {
        const msg = `[services] tools_install: ${tool.name} failed (exit ${r.status})`;
        if (tool.optional) {
          console.warn(`${msg} — continuing (optional)`);
          break;
        }
        console.error(msg);
        process.exit(1);
      }
    }
  }
}

// ---------- service lifecycle ----------

// name → { child, started_at, log_file, exit_code, exit_signal }
const running = new Map();

function logPath(name) { return path.join(LOG_DIR, `${name}.log`); }

function startService(name) {
  const config = loadConfig();
  const spec = (config.services || {})[name];
  if (!spec) { const e = new Error(`unknown service: ${name}`); e.status = 404; throw e; }
  if (running.has(name) && running.get(name).child && !running.get(name).child.exitCode &&
      running.get(name).child.exitCode === null) {
    const e = new Error(`service already running: ${name}`); e.status = 409; throw e;
  }

  const store = loadSecretStore(config);
  const secretEnv = selectSecrets(spec.secrets, store);

  const file = logPath(name);
  const out = createWriteStream(file, { flags: "a" });
  out.write(`\n[services] ${new Date().toISOString()} starting ${name}: ${spec.command.join(" ")}\n`);

  const env = {
    PATH: process.env.PATH,
    HOME: "/home/agent",
    TMPDIR: "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    TERM: "xterm-256color",
    ...(spec.env || {}),
    ...secretEnv,
  };

  const child = spawn(spec.command[0], spec.command.slice(1), {
    cwd: spec.cwd || "/workspace",
    env,
    uid: RUN_UID,
    gid: RUN_GID,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout.on("data", (d) => out.write(d));
  child.stderr.on("data", (d) => out.write(d));

  const record = {
    child, pid: child.pid, started_at: new Date().toISOString(),
    log_file: file, exit_code: null, exit_signal: null,
  };
  running.set(name, record);

  child.on("exit", (code, signal) => {
    record.exit_code = code;
    record.exit_signal = signal;
    out.write(`\n[services] ${new Date().toISOString()} ${name} exited code=${code} signal=${signal}\n`);
    out.end();
  });

  child.on("error", (err) => {
    out.write(`\n[services] ${name} spawn error: ${err.message}\n`);
    record.exit_code = -1;
  });

  return { name, pid: child.pid, started_at: record.started_at };
}

function stopService(name, signal = "SIGTERM") {
  const rec = running.get(name);
  if (!rec || !rec.child || rec.child.exitCode !== null) {
    const e = new Error(`service not running: ${name}`); e.status = 404; throw e;
  }
  rec.child.kill(signal);
  return { name, signaled: signal };
}

function listServices() {
  const config = loadConfig();
  return Object.keys(config.services || {});
}

function statusAll() {
  const out = [];
  const config = loadConfig();
  for (const name of Object.keys(config.services || {})) {
    const rec = running.get(name);
    if (!rec) {
      out.push({ name, state: "stopped" });
      continue;
    }
    const isAlive = rec.child && rec.child.exitCode === null && rec.exit_code === null;
    out.push({
      name,
      state: isAlive ? "running" : "exited",
      pid: rec.pid,
      started_at: rec.started_at,
      exit_code: rec.exit_code,
      exit_signal: rec.exit_signal,
    });
  }
  return out;
}

// ---------- HTTP ----------

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  return body.trim() ? JSON.parse(body) : {};
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isValidName(n) { return typeof n === "string" && /^[a-z][a-z0-9_-]*$/i.test(n); }

function streamLogs(res, name, { tail, follow }) {
  const file = logPath(name);
  if (!existsSync(file)) {
    return writeJson(res, 404, { error: `no logs yet for ${name}` });
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });

  // Tail: seek to last N lines if requested, else stream from start.
  let start = 0;
  if (typeof tail === "number" && tail > 0) {
    const size = statSync(file).size;
    // Cheap heuristic: 200 bytes per line on average; tighten if needed.
    start = Math.max(0, size - tail * 400);
  }

  const stream = createReadStream(file, { start });
  stream.pipe(res, { end: !follow });

  if (!follow) return;

  // Naive follow: re-poll the file every 500ms and write any new bytes.
  let cursor = statSync(file).size;
  const timer = setInterval(() => {
    try {
      const size = statSync(file).size;
      if (size > cursor) {
        const s2 = createReadStream(file, { start: cursor, end: size - 1 });
        s2.on("data", (d) => res.write(d));
        s2.on("end", () => { cursor = size; });
      } else if (size < cursor) {
        // truncated/rotated — restart from 0
        cursor = 0;
      }
    } catch { /* file gone, ignore until next tick */ }
  }, 500);

  res.on("close", () => clearInterval(timer));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return writeJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/list") {
      return writeJson(res, 200, { services: listServices() });
    }
    if (req.method === "GET" && req.url === "/status") {
      return writeJson(res, 200, { services: statusAll() });
    }

    // Explicit deny — same defense-in-depth as broker.
    if (req.url === "/raw-env" || req.url === "/secrets" || req.url === "/env") {
      return writeJson(res, 403, { error: "secret material is not exposed" });
    }

    const startMatch = req.url.match(/^\/start\/([^?]+)$/);
    if (req.method === "POST" && startMatch) {
      const name = decodeURIComponent(startMatch[1]);
      if (!isValidName(name)) return writeJson(res, 400, { error: "invalid service name" });
      try {
        const r = startService(name);
        return writeJson(res, 200, r);
      } catch (err) {
        return writeJson(res, err.status || 500, { error: err.message });
      }
    }

    const stopMatch = req.url.match(/^\/stop\/([^?]+)$/);
    if (req.method === "POST" && stopMatch) {
      const name = decodeURIComponent(stopMatch[1]);
      if (!isValidName(name)) return writeJson(res, 400, { error: "invalid service name" });
      let signal = "SIGTERM";
      try {
        const body = await readJson(req);
        if (body && typeof body.signal === "string") signal = body.signal;
      } catch { /* empty body is fine */ }
      try {
        const r = stopService(name, signal);
        return writeJson(res, 200, r);
      } catch (err) {
        return writeJson(res, err.status || 500, { error: err.message });
      }
    }

    const logMatch = req.url.match(/^\/logs\/([^?]+)(?:\?(.*))?$/);
    if (req.method === "GET" && logMatch) {
      const name = decodeURIComponent(logMatch[1]);
      if (!isValidName(name)) return writeJson(res, 400, { error: "invalid service name" });
      if (!listServices().includes(name)) {
        return writeJson(res, 404, { error: `unknown service: ${name}` });
      }
      const params = new URLSearchParams(logMatch[2] || "");
      const tail = params.has("tail") ? Number(params.get("tail")) : 0;
      const follow = params.get("follow") === "true" || params.get("follow") === "1";
      return streamLogs(res, name, { tail, follow });
    }

    writeJson(res, 404, { error: "not found" });
  } catch (err) {
    writeJson(res, 500, { error: err.message });
  }
});

// ---------- main ----------

try {
  const config = loadConfig();
  runToolsInstall(config);
} catch (err) {
  console.error(`[services] config load failed: ${err.message}`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`[services] listening on http://${HOST}:${PORT}`);
  console.log(`[services] config: ${CONFIG_PATH}`);
  console.log(`[services] logs:   ${LOG_DIR}`);
});

function shutdown(sig) {
  console.log(`[services] received ${sig}, stopping all services`);
  for (const [name, rec] of running.entries()) {
    if (rec.child && rec.child.exitCode === null) {
      try { rec.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }
  // Give children a moment to flush, then exit.
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
