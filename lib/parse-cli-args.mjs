// Small, declarative argv parser shared by the bin/sandbox-* scripts. It
// handles the patterns each script already used by hand:
//   - long flags with optional short aliases  (--config / no short)
//   - value flags vs boolean flags             (--config <path> vs --dry-run)
//   - --help / -h that prints the script's help and exits 0
//   - optional "rest" mode: the first non-flag argument plus everything after
//     it is captured into a named array (used by sandbox-up to grab a trailing
//     `cmd...` for the agent shell)
//
// Unknown flags are silently ignored. Each script previously did this so that
// retired aliases (e.g. sandbox-apply's old --delete / --checksum, now both
// the default) wouldn't break user scripts; preserving that here keeps the
// migration risk-free.
//
// Spec shape:
//   {
//     flags: {
//       configPath: { long: "--config",   takesValue: true },
//       dryRun:     { long: "--dry-run",  short: "-n" },
//       yes:        { long: "--yes",      short: "-y" },
//     },
//     rest: "cmd",                       // optional, see above
//     printHelp: () => { ... },          // called on --help / -h, then exit 0
//   }
//
// Result:
//   { <flagName>: <value>, ... [, <rest>: [...] ] }
// Value flags default to null when absent; boolean flags default to false;
// rest defaults to an empty array.

import process from "node:process";

export function parseCliArgs(argv, spec) {
  const flagMap = {};
  const out = {};
  for (const [name, def] of Object.entries(spec.flags || {})) {
    out[name] = def.takesValue ? null : false;
    if (def.long)  flagMap[def.long]  = { name, takesValue: !!def.takesValue };
    if (def.short) flagMap[def.short] = { name, takesValue: !!def.takesValue };
  }
  if (spec.rest) out[spec.rest] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      if (spec.printHelp) spec.printHelp();
      process.exit(0);
    }
    const f = flagMap[a];
    if (f) {
      if (f.takesValue) out[f.name] = argv[++i];
      else out[f.name] = true;
      continue;
    }
    if (spec.rest) {
      // Once we see a non-flag, the rest of argv is positional. Mirrors the
      // hand-rolled behavior in bin/sandbox-up.
      out[spec.rest] = argv.slice(i);
      break;
    }
    // Unknown flag (no rest mode): ignore to preserve back-compat aliases.
  }
  return out;
}
