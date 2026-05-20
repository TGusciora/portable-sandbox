// Thin wrappers around spawnSync shared by the bin/sandbox-* scripts.
//
//   silent(cmd, args)  — runs with stdout AND stderr suppressed. Use for
//                        cleanup operations where failures are expected and
//                        ignored: removing a container that doesn't exist,
//                        disconnecting a network endpoint that's already
//                        gone, chmod'ing a tree that may have missing paths.
//
//   capture(cmd, args) — runs and captures stdout/stderr as utf8 strings,
//                        without printing them. Use for queries where the
//                        caller wants to read the command's output
//                        programmatically (e.g. `docker ps --format` to
//                        list container names).
//
// Both return the raw spawnSync result so the caller can inspect .status,
// .stdout, .stderr. Neither throws or exits on a non-zero status — that
// policy belongs in the caller, where the right behavior is context-specific
// (silent commands usually shouldn't exit; capture commands sometimes should).

import { spawnSync } from "node:child_process";

export function silent(cmd, args) {
  return spawnSync(cmd, args, { stdio: "ignore" });
}

export function capture(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}
