// Prefixed logger used by the bin/sandbox-* scripts. Two streams:
//   .out(msg) — prints to stdout, prefixed with [<tool>]. Use for primary
//               output (e.g. status lines from sandbox-down / sandbox-discard
//               where stdout is just informational).
//   .err(msg) — prints to stderr, prefixed with [<tool>]. Use for progress,
//               warnings, and errors in scripts whose stdout carries data
//               the user may pipe — sandbox-diff produces a unified diff on
//               stdout, sandbox-apply produces rsync's itemize output.
//               Mixing progress lines into those streams would corrupt them.
//
// Continuation lines (lines that visually align under an earlier message,
// without their own [<tool>] prefix) keep using console.log / console.error
// directly. The factory deliberately doesn't try to handle that case — it
// would either over-prefix or guess at indentation rules.

export function createLog(tool) {
  const prefix = `[${tool}]`;
  return {
    out: (msg) => console.log(`${prefix} ${msg}`),
    err: (msg) => console.error(`${prefix} ${msg}`),
  };
}
