// Config loader. Zero deps — vendored YAML subset parser inside.
//
// Supported YAML subset:
//   * Scalars: strings (quoted or bare), numbers, booleans, null
//   * Block maps (2-space indented)
//   * Block sequences (`- item`)
//   * Flow sequences (`[a, b]`) and flow maps (`{a: 1, b: 2}`) — values only
//   * Comments (# ...) and blank lines ignored
//
// NOT supported: anchors/aliases, multi-line strings, tags, document streams.
// If you need any of that, the config is too clever — keep it boring.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- tokenizer ----------

function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Turn raw YAML text into a list of {indent, content, lineNo} records — one
// per non-empty, non-comment line. For each source line we:
//   1. Strip any trailing `# comment` (respecting quotes, so '#' inside a
//      string isn't mistaken for a comment).
//   2. Skip the line if it's blank after that.
//   3. Reject tab indentation (YAML forbids it; ambiguous with spaces).
//   4. Record how many leading spaces it has (the block parser uses this to
//      figure out nesting) and the trimmed remainder.
//   5. Keep the original source line number, so error messages can point at
//      the right place when the config doesn't parse.
function tokenize(text) {
  const out = [];
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const stripped = stripComment(raw).replace(/\s+$/, "");
    if (!stripped.trim()) continue;
    if (stripped.includes("\t")) {
      throw new Error(`config: tab character not allowed (line ${lineNo})`);
    }
    const indent = stripped.length - stripped.trimStart().length;
    out.push({ indent, content: stripped.trimStart(), lineNo });
  }
  return out;
}

// ---------- scalar parsing ----------

function parseScalar(text) {
  const s = text.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) return parseFlowSeq(s.slice(1, -1));
  if (s.startsWith("{") && s.endsWith("}")) return parseFlowMap(s.slice(1, -1));
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

function splitFlow(text) {
  // split on top-level commas
  const out = [];
  let depth = 0, inS = false, inD = false, buf = "";
  for (const c of text) {
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (c === "[" || c === "{")) depth++;
    else if (!inS && !inD && (c === "]" || c === "}")) depth--;
    if (c === "," && depth === 0 && !inS && !inD) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

function parseFlowSeq(inner) {
  return splitFlow(inner).map((item) => parseScalar(item.trim()));
}

function parseFlowMap(inner) {
  const out = {};
  for (const pair of splitFlow(inner)) {
    const colon = findKeyColon(pair);
    if (colon === -1) throw new Error(`config: bad flow map entry: ${pair}`);
    out[pair.slice(0, colon).trim()] = parseScalar(pair.slice(colon + 1).trim());
  }
  return out;
}

function findKeyColon(text) {
  let inS = false, inD = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ":" && !inS && !inD) {
      const next = text[i + 1];
      if (next === undefined || next === " " || next === "\t") return i;
    }
  }
  return -1;
}

// ---------- block parser ----------

function parseBlock(lines, i, indent) {
  if (i >= lines.length || lines[i].indent !== indent) return [null, i];
  if (lines[i].content.startsWith("- ") || lines[i].content === "-") {
    return parseSeq(lines, i, indent);
  }
  return parseMap(lines, i, indent);
}

function parseMap(lines, i, indent) {
  const obj = {};
  while (i < lines.length && lines[i].indent === indent && !lines[i].content.startsWith("- ")) {
    const { content, lineNo } = lines[i];
    const colon = findKeyColon(content);
    if (colon === -1) throw new Error(`config: expected key:value on line ${lineNo}`);
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    i++;
    if (rest === "") {
      if (i < lines.length && lines[i].indent > indent) {
        const childIndent = lines[i].indent;
        const [val, ni] = parseBlock(lines, i, childIndent);
        obj[key] = val;
        i = ni;
      } else {
        obj[key] = null;
      }
    } else {
      obj[key] = parseScalar(rest);
    }
  }
  return [obj, i];
}

function parseSeq(lines, i, indent) {
  const arr = [];
  while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith("-")) {
    const { content, lineNo } = lines[i];
    const after = content === "-" ? "" : content.slice(2);

    // object item: "- key: value" (and possibly more keys at indent+2)
    const colon = findKeyColon(after);
    const looksLikeMap = colon !== -1 && !after.startsWith("[") && !after.startsWith("{");

    if (after === "") {
      // sub-block on next line
      i++;
      if (i < lines.length && lines[i].indent > indent) {
        const [val, ni] = parseBlock(lines, i, lines[i].indent);
        arr.push(val);
        i = ni;
      } else {
        arr.push(null);
      }
    } else if (looksLikeMap) {
      const obj = {};
      const key = after.slice(0, colon).trim();
      const rest = after.slice(colon + 1).trim();
      i++;
      if (rest === "") {
        if (i < lines.length && lines[i].indent > indent + 2) {
          const [val, ni] = parseBlock(lines, i, lines[i].indent);
          obj[key] = val;
          i = ni;
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(rest);
      }
      // sibling keys at indent + 2
      const inner = indent + 2;
      while (i < lines.length && lines[i].indent === inner && !lines[i].content.startsWith("- ")) {
        const c2 = lines[i].content;
        const k2col = findKeyColon(c2);
        if (k2col === -1) throw new Error(`config: expected key:value on line ${lines[i].lineNo}`);
        const k2 = c2.slice(0, k2col).trim();
        const r2 = c2.slice(k2col + 1).trim();
        i++;
        if (r2 === "") {
          if (i < lines.length && lines[i].indent > inner) {
            const [v, ni] = parseBlock(lines, i, lines[i].indent);
            obj[k2] = v;
            i = ni;
          } else {
            obj[k2] = null;
          }
        } else {
          obj[k2] = parseScalar(r2);
        }
      }
      arr.push(obj);
    } else {
      arr.push(parseScalar(after));
      i++;
    }
  }
  return [arr, i];
}

export function parseYaml(text) {
  const lines = tokenize(text);
  if (lines.length === 0) return {};
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return value;
}

// ---------- config load + validate ----------

function expandHome(p) {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1));
  return p;
}

function resolveAgainst(baseDir, p) {
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

export function loadConfig(configPath) {
  const absConfig = path.resolve(configPath);
  const configDir = path.dirname(absConfig);
  const raw = parseYaml(readFileSync(absConfig, "utf8"));

  if (!raw || typeof raw !== "object") {
    throw new Error("config: top-level must be a map");
  }
  if (!raw.target || typeof raw.target !== "string") {
    throw new Error("config: 'target' (path to repo) is required");
  }

  const target = resolveAgainst(configDir, expandHome(raw.target));

  const images = raw.images || {};
  const config = {
    configPath: absConfig,
    configDir,
    target,
    images: {
      build_locally: images.build_locally !== false,
      agent: images.agent || "portable-sandbox-agent:local",
      broker: images.broker || "portable-sandbox-broker:local",
      // Services container reuses the agent image by default — same base
      // runtime (node, uv, pnpm, python3). Override via services_image.extends
      // for per-target build-time customization.
      services: images.services || images.agent || "portable-sandbox-agent:local",
    },
    hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    readonly: Array.isArray(raw.readonly) ? raw.readonly : [],
    install: [],
    dep_volumes: [],
    secrets: [],
    recipes: {},
    services: {},
    tools_install: [],
    mounts: [],
    services_image: null,
    ports: [],
    compose: null,
  };

  for (const p of (raw.ports || [])) {
    const s = String(p);
    // Accept "host:container", "host:container/proto", or just "container".
    // We don't try to fully validate — docker run will reject anything bad.
    if (!/^[0-9.:/a-z-]+$/i.test(s)) {
      throw new Error(`config.ports: invalid port spec '${s}' (expected e.g. "3000:3000" or "3000:3000/tcp")`);
    }
    config.ports.push(s);
  }

  if (raw.compose) {
    if (typeof raw.compose !== "object" || Array.isArray(raw.compose)) {
      throw new Error("config.compose: must be a map with 'file' and optional 'services'");
    }
    if (!raw.compose.file || typeof raw.compose.file !== "string") {
      throw new Error("config.compose.file: required path to a docker-compose.yml");
    }
    const services = raw.compose.services || [];
    if (!Array.isArray(services)) {
      throw new Error("config.compose.services: must be a list of service names (or omit to bring up all)");
    }
    config.compose = {
      file: resolveAgainst(configDir, expandHome(raw.compose.file)),
      services: services.map(String),
    };
  }

  for (const cmd of (raw.install || [])) {
    if (!Array.isArray(cmd) || cmd.length === 0) {
      throw new Error("config.install: each entry must be a non-empty argv list, e.g. [uv, sync]");
    }
    config.install.push(cmd.map(String));
  }

  for (const v of (raw.dep_volumes || [])) {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error("config.dep_volumes: entries must be non-empty path strings");
    }
    if (v.startsWith("/") || v.includes("..")) {
      throw new Error(`config.dep_volumes: path must be relative to /workspace and not contain '..': ${v}`);
    }
    config.dep_volumes.push(v.replace(/^\.\//, "").replace(/\/+$/, ""));
  }

  for (const entry of (raw.secrets || [])) {
    if (!entry || typeof entry !== "object") {
      throw new Error("config.secrets: each entry must be {name, path}");
    }
    if (!entry.name || !entry.path) {
      throw new Error("config.secrets: entry missing name or path");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(entry.name)) {
      throw new Error(`config.secrets: invalid name '${entry.name}'`);
    }
    config.secrets.push({
      name: entry.name,
      hostPath: resolveAgainst(configDir, expandHome(entry.path)),
    });
  }

  // ---- services: long-running processes in the services container ----
  // Each declares an argv, optional secrets bundles, optional host ports
  // (published from the services container, not the agent), and an optional
  // cwd inside /workspace.
  for (const [name, svc] of Object.entries(raw.services || {})) {
    if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
      throw new Error(`config.services: invalid name '${name}'`);
    }
    if (!svc || !Array.isArray(svc.command) || svc.command.length === 0) {
      throw new Error(`config.services.${name}: 'command' must be a non-empty list`);
    }
    const secrets = svc.secrets || [];
    if (!Array.isArray(secrets)) {
      throw new Error(`config.services.${name}: 'secrets' must be a list of secret names`);
    }
    for (const s of secrets) {
      if (!config.secrets.find((x) => x.name === s)) {
        throw new Error(`config.services.${name}: secret '${s}' not declared in top-level 'secrets'`);
      }
    }
    const svcPorts = [];
    for (const p of (svc.ports || [])) {
      const s = String(p);
      if (!/^[0-9.:/a-z-]+$/i.test(s)) {
        throw new Error(`config.services.${name}.ports: invalid '${s}'`);
      }
      svcPorts.push(s);
    }
    const env = {};
    if (svc.env) {
      if (typeof svc.env !== "object" || Array.isArray(svc.env)) {
        throw new Error(`config.services.${name}.env: must be a map of key:value`);
      }
      for (const [k, v] of Object.entries(svc.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
          throw new Error(`config.services.${name}.env: invalid key '${k}'`);
        }
        env[k] = String(v);
      }
    }
    config.services[name] = {
      command: svc.command.map(String),
      secrets,
      ports: svcPorts,
      cwd: svc.cwd ? String(svc.cwd) : "/workspace",
      env,
    };
  }

  // ---- tools_install: declarative tool provisioning at services startup ----
  // Each entry has a `check` (argv to test presence — skip install if exit 0)
  // and an `install` list (argv commands to run as root inside the services
  // container). Failure aborts unless `optional: true`.
  for (const tool of (raw.tools_install || [])) {
    if (!tool || typeof tool !== "object") {
      throw new Error("config.tools_install: each entry must be a map");
    }
    if (!tool.name || typeof tool.name !== "string") {
      throw new Error("config.tools_install: each entry needs a 'name'");
    }
    if (!Array.isArray(tool.install) || tool.install.length === 0) {
      throw new Error(`config.tools_install.${tool.name}: 'install' must be a non-empty list of argv lists`);
    }
    const installCmds = [];
    for (const cmd of tool.install) {
      if (!Array.isArray(cmd) || cmd.length === 0) {
        throw new Error(`config.tools_install.${tool.name}: install entries must be non-empty argv lists`);
      }
      installCmds.push(cmd.map(String));
    }
    const check = tool.check ? (Array.isArray(tool.check) ? tool.check.map(String) : null) : null;
    if (tool.check && !check) {
      throw new Error(`config.tools_install.${tool.name}: 'check' must be an argv list`);
    }
    config.tools_install.push({
      name: tool.name,
      check,
      install: installCmds,
      optional: tool.optional === true,
    });
  }

  // ---- mounts: arbitrary host paths into the services container ----
  // For credentials (gws / aws / kube / ssh), caches, etc. Agent never sees
  // these — only the services container does.
  for (const m of (raw.mounts || [])) {
    if (!m || typeof m !== "object") {
      throw new Error("config.mounts: each entry must be {src, dst, [readonly]}");
    }
    if (!m.src || !m.dst) {
      throw new Error("config.mounts: entry missing src or dst");
    }
    config.mounts.push({
      src: resolveAgainst(configDir, expandHome(String(m.src))),
      dst: String(m.dst),
      readonly: m.readonly !== false,
    });
  }

  // ---- services_image: optional per-target Dockerfile escape hatch ----
  // If `extends` is set, sandbox-up builds it and uses the result instead of
  // the default services image. The Dockerfile should FROM the base agent
  // image so node/uv/pnpm/python3 stay available.
  if (raw.services_image) {
    if (typeof raw.services_image !== "object") {
      throw new Error("config.services_image: must be a map");
    }
    if (raw.services_image.extends) {
      config.services_image = {
        extends: resolveAgainst(configDir, expandHome(String(raw.services_image.extends))),
      };
    }
  }

  for (const [name, recipe] of Object.entries(raw.recipes || {})) {
    if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
      throw new Error(`config.recipes: invalid name '${name}'`);
    }
    if (!recipe || !Array.isArray(recipe.command) || recipe.command.length === 0) {
      throw new Error(`config.recipes.${name}: 'command' must be a non-empty list`);
    }
    const secrets = recipe.secrets || [];
    if (!Array.isArray(secrets)) {
      throw new Error(`config.recipes.${name}: 'secrets' must be a list of secret names`);
    }
    for (const s of secrets) {
      if (!config.secrets.find((x) => x.name === s)) {
        throw new Error(`config.recipes.${name}: secret '${s}' not declared in top-level 'secrets'`);
      }
    }
    config.recipes[name] = {
      command: recipe.command.map(String),
      secrets,
      timeoutSec: recipe.timeoutSec || 120,
    };
  }

  return config;
}

// CLI: `node lib/config.mjs path/to/sandbox-config.yaml`
// Prints the resolved config as JSON. Useful for sandbox-up and for debugging.
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig(process.argv[2]);
  process.stdout.write(JSON.stringify(cfg, null, 2));
}
