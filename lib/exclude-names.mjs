// Basename-level exclude list shared by sandbox-apply (passed to rsync as
// --exclude) and sandbox-diff (passed to diff as -x). Both tools match names
// at any depth in the tree, so this list is intentionally coarse — we filter
// by basename only.
//
// The set is built from:
//   1. A baked-in set of universally-ignored caches and build artifacts that
//      should never round-trip back to the target repo (.git, node_modules,
//      .DS_Store, Python/Node caches, the broker's internal state dir, and
//      the host→agent file drop-box).
//   2. The basename of every pattern in the config's `hidden`, `readonly`,
//      and `dep_volumes` lists. Trailing `/**` is stripped before taking the
//      basename. This keeps the agent's hidden/readonly choices out of any
//      apply/diff regardless of where in the tree they sit.
//
// Anything that needs path-precision (e.g. "match `secrets/foo` but not
// `bin/foo`") is enforced separately — sandbox-apply layers rsync
// --filter='P ...' protect rules on top of these excludes for exactly that
// reason. See bin/sandbox-apply for the full safety stack.

export function excludeNames(config) {
  const out = new Set([
    ".git", "node_modules", ".DS_Store", ".sandbox-broker-state",
    // host→agent file drop-box created by sandbox-up; never round-trip back
    "tmp_attachments",
    // python
    "__pycache__", "*.pyc", "*.pyo", ".pytest_cache", ".ruff_cache", ".mypy_cache",
    // node / pnpm
    ".pnpm-store",
  ]);
  const patterns = [...config.hidden, ...config.readonly, ...config.dep_volumes];
  for (const p of patterns) {
    const stripped = p.replace(/\/\*\*$/, "");
    const base = stripped.split("/").pop();
    if (base) out.add(base);
  }
  return [...out];
}
