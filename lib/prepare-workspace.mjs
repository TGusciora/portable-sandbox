// Build a throwaway copy of the target repo and resolve readonly mount specs.
//
// Two layers of read-only enforcement (belt and suspenders):
//   1. chmod 0444/0555 inside the workspace copy — cheap, but bypassable if
//      the agent process's uid matches the file owner uid.
//   2. (Done in bin/sandbox-up) per-path `--mount ...,readonly` bind mounts
//      that overlay the workspace. Enforced by the kernel regardless of uid.
//
// The original target repo is never modified.

import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync,
  readdirSync, statSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "./config.mjs";

const READONLY_STATE_FILE = ".sandbox-broker-state/readonly-applied.json";
const GIT_ORIGIN_BRANCH_FILE = ".sandbox-broker-state/git-origin-branch.txt";

// Stable workspace path per target. Same target → same workspace dir across
// launches, so the agent's changes survive sandbox-down and can be reviewed
// with sandbox-diff / sandbox-apply / sandbox-discard.
export function targetSlug(targetPath) {
  return createHash("sha256").update(targetPath).digest("hex").slice(0, 10);
}

export function workspacePathFor(targetPath) {
  return path.join(os.tmpdir(), `portable-sandbox-workspace-${targetSlug(targetPath)}`);
}

// Convert a shell-style glob into a JS RegExp that we can run against
// forward-slash-joined relative paths. Translation rules:
//   *   matches anything except a path separator — so `*.env` only matches
//       files in the current directory, not `nested/foo.env`.
//   **  matches across path separators — so `secrets/**` covers
//       `secrets/foo`, `secrets/a/b`, etc.
//   . + ^ $ { } ( ) | [ ] \   are first regex-escaped so they're literal.
//
// We do the `**` substitution as a two-step trick: replace `**` with a sentinel
// space, then replace single `*` with `[^/]*`, then turn the sentinel back
// into `.*`. This avoids the order-dependency of regex replacements on the
// same string and keeps each step single-purpose.
function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${escaped}$`);
}

// gitignore-style matching: evaluate every pattern against the path in order,
// and let the LAST one to match decide whether the path is "in" the set. A
// pattern with a leading `!` reverses an earlier match (re-allows the path).
//
// Why last-wins matters: it lets you write a broad rule first and then carve
// out exceptions. For example:
//   hidden: [".env*", "!.env.example", "!.env.sample"]
// means "hide every .env file EXCEPT the two template files". Order of the
// !-rules vs the broad rule matters — flipping them would re-hide the
// templates. Same shape works for `readonly:`.
function matchesAny(relPath, patterns) {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (globToRegex(p.slice(1)).test(relPath)) matched = false;
    } else {
      if (globToRegex(p).test(relPath)) matched = true;
    }
  }
  return matched;
}

function chmodTree(p, fileMode, dirMode) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const entry of readdirSync(p)) chmodTree(path.join(p, entry), fileMode, dirMode);
    chmodSync(p, dirMode);
  } else {
    chmodSync(p, fileMode);
  }
}

function walkRel(root, onRel) {
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(root, rel);
    let entries;
    try { entries = readdirSync(abs); } catch { continue; }
    for (const name of entries) {
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = path.join(abs, name);
      let st;
      try { st = statSync(childAbs); } catch { continue; }
      onRel(childRel, st);
      if (st.isDirectory()) stack.push(childRel);
    }
  }
}

// Resolve readonly patterns to concrete relative paths inside the workspace.
// Supported pattern shapes:
//   * literal path (e.g. "package.json", "migrations")
//   * trailing-globstar (e.g. "migrations/**") → mounts the directory
//   * stars elsewhere (e.g. "*.lock", "src/**/*.gen.ts") → walks and matches
export function resolveReadonlyMounts(workspaceDir, patterns) {
  const out = new Set();
  for (const pattern of patterns) {
    const stripped = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    if (!stripped.includes("*")) {
      if (existsSync(path.join(workspaceDir, stripped))) out.add(stripped);
      continue;
    }
    const re = globToRegex(pattern);
    walkRel(workspaceDir, (rel) => { if (re.test(rel)) out.add(rel); });
  }
  return [...out];
}

export function prepareWorkspace(config) {
  const dest = workspacePathFor(config.target);
  const reused = existsSync(dest);

  if (!reused) {
    cpSync(config.target, dest, {
      recursive: true,
      // Preserve mtimes so sandbox-apply can distinguish files the agent
      // actually touched from untouched files. Without this, every file in
      // the workspace gets mtime=now at copy time, and rsync later sees
      // mtime-mismatch on the entire tree.
      preserveTimestamps: true,
      filter: (src) => {
        const rel = path.relative(config.target, src).split(path.sep).join("/");
        if (!rel) return true;
        const parts = rel.split("/");
        if (parts.includes(".git") || parts.includes("node_modules") || parts.includes(".DS_Store")) {
          return false;
        }
        return !matchesAny(rel, config.hidden);
      },
    });
  }

  // Drop a fresh, sanitized .git into the workspace via `git clone --local`.
  // Done as a separate step (not via cpSync) so host's hooks, credential
  // helpers, sshCommand, and embedded-token URLs from .git/config never reach
  // the sandbox. --no-hardlinks ensures the agent cannot mutate the host's
  // object database. Apply/diff/discard still exclude .git, so the agent
  // cannot round-trip hooks or rewrite history on the host; commits travel
  // back via sandbox-merge (git fetch + ff-only).
  ensureSandboxGit(dest, config.target);

  // sandbox-up creates a tmp_attachments/ drop-box inside the workspace for
  // host→agent file paste-ins. Keep it out of git so the agent can't
  // accidentally `git add` host clipboard contents and round-trip them via
  // sandbox-merge. Idempotent: only appends if the entry is missing.
  ensureGitignoreEntry(dest, "tmp_attachments/");

  // Belt: chmod readonly paths. Bind-mount readonly overlays (added in
  // sandbox-up) are the suspenders. Stateful so that removing a pattern from
  // the config releases the chmod next launch — without this, perms set on a
  // previous run stay sticky and "writable: yes" in the config doesn't take
  // effect until sandbox-discard.
  applyReadonlyPolicy(dest, config.readonly);

  return { dest, reused };
}

function gitCurrentBranch(repoDir) {
  const r = spawnSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`prepare-workspace: 'git rev-parse' failed in ${repoDir}: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

// Materialize a fresh .git in the workspace. Idempotent: if a workspace was
// created by an older portable-sandbox version with no .git, this still
// produces one on next launch. We never overwrite an existing .git — that
// would clobber the agent's in-progress commits.
function ensureSandboxGit(workspaceDir, targetDir) {
  const gitDir = path.join(workspaceDir, ".git");
  if (existsSync(gitDir)) {
    // Refresh the recorded source branch from current target HEAD only if
    // missing — once recorded for a workspace, it's the merge contract.
    const branchFile = path.join(workspaceDir, GIT_ORIGIN_BRANCH_FILE);
    if (!existsSync(branchFile)) {
      const branch = gitCurrentBranch(targetDir);
      if (branch === "HEAD") {
        throw new Error("prepare-workspace: target is in detached HEAD; check out a branch before launching the sandbox.");
      }
      mkdirSync(path.dirname(branchFile), { recursive: true });
      writeFileSync(branchFile, branch + "\n");
    }
    return;
  }

  const branch = gitCurrentBranch(targetDir);
  if (branch === "HEAD") {
    throw new Error("prepare-workspace: target is in detached HEAD; check out a branch before launching the sandbox.");
  }

  // Clone into a sibling tempdir, then move the .git out and discard the
  // working tree (cpSync already populated the workspace working tree, and
  // we want to preserve those files including the agent's mtimes).
  const stageDir = `${workspaceDir}.gitstage-${process.pid}`;
  try {
    const c = spawnSync("git", [
      "clone", "--local", "--no-hardlinks", "--quiet",
      "--branch", branch, "--single-branch",
      targetDir, stageDir,
    ], { encoding: "utf8" });
    if (c.status !== 0) {
      throw new Error(`prepare-workspace: git clone failed: ${c.stderr || c.stdout}`);
    }
    // Move the cloned .git into the workspace. cpSync (recursive) is fine here
    // — pack files are content-addressed; mtimes don't matter for git.
    cpSync(path.join(stageDir, ".git"), gitDir, { recursive: true });
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }

  // Drop the origin remote: the cloned URL points at the host filesystem path,
  // which the sandbox container cannot reach anyway. Removing it prevents
  // confusing 'git fetch'/'git push' errors and avoids leaking the host path
  // into agent-visible config. The agent can add its own remotes if needed.
  spawnSync("git", ["-C", workspaceDir, "remote", "remove", "origin"], { encoding: "utf8" });

  // Record the source branch so sandbox-merge knows what to merge into on the host.
  const branchFile = path.join(workspaceDir, GIT_ORIGIN_BRANCH_FILE);
  mkdirSync(path.dirname(branchFile), { recursive: true });
  writeFileSync(branchFile, branch + "\n");
}

export function readOriginBranch(workspaceDir) {
  const f = path.join(workspaceDir, GIT_ORIGIN_BRANCH_FILE);
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").trim();
}

function ensureGitignoreEntry(workspaceDir, entry) {
  const gitignorePath = path.join(workspaceDir, ".gitignore");
  let existing = "";
  try { existing = readFileSync(gitignorePath, "utf8"); } catch { /* file may not exist */ }
  const lines = existing.split("\n").map((l) => l.trim());
  if (lines.includes(entry)) return;
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(gitignorePath, `${prefix}${entry}\n`);
}

function applyReadonlyPolicy(dest, currentPatterns) {
  const statePath = path.join(dest, READONLY_STATE_FILE);
  let previous = [];
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (Array.isArray(parsed.patterns)) previous = parsed.patterns;
  } catch { /* fresh workspace or missing file */ }

  const currentSet = new Set(currentPatterns);

  // Release: patterns that were readonly last time but aren't now → restore
  // writable perms so the agent can edit them this session.
  for (const p of previous) {
    if (currentSet.has(p)) continue;
    const stripped = p.endsWith("/**") ? p.slice(0, -3) : p;
    try { chmodTree(path.join(dest, stripped), 0o644, 0o755); } catch { /* path no longer exists or never resolved */ }
  }

  // Enforce: current readonly patterns get 0444/0555.
  for (const p of currentPatterns) {
    const stripped = p.endsWith("/**") ? p.slice(0, -3) : p;
    try { chmodTree(path.join(dest, stripped), 0o444, 0o555); } catch { /* fine */ }
  }

  // Persist for next launch.
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ patterns: currentPatterns }, null, 2));
}

// CLI: `node lib/prepare-workspace.mjs <config>` → prints workspace dir
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig(process.argv[2]);
  process.stdout.write(prepareWorkspace(cfg).dest);
}
