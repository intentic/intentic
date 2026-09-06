#!/usr/bin/env node
/* THE DAEMON'S MODULE BOUNDARIES, HELD WHERE THEY STAND AND ALLOWED TO MOVE ONE WAY.
 *
 * `_sandbox/sandbox` is one deployable and sixty-odd subsystem directories under one src/. Nothing between them
 * is enforced: the package graph is checked by pnpm and turbo, the extension boundary by a lint rule
 * (.oxlintrc.json), and the seams INSIDE the daemon by whoever happens to read the diff. Measured at the commit
 * this was written, every subsystem sits in one strongly connected component of runtime imports, and the
 * composition root's `Services` interface (107 members) is imported by 148 production files. Neither number is
 * wrong on its own, a modular monolith is the right shape for this daemon, but both drift silently, and drift
 * in one direction only: nobody adds a cycle on purpose, and nobody notices the one they added.
 *
 * Two shapes are recognized, each by reading the source, and each is held to a backlog that may shrink and
 * may not grow (the same mechanism as invariant-registry.mjs: the debt is a list in the open, a new entry fails
 * by name, a stale entry is REPORTED and never fails: with a dozen conversations landing into one tree, the
 * turn that removed a cycle is not the one that should be refused for it, and neither is everyone else's):
 *
 *   1. A NARROW TAKER OF `Services`. composition.ts states the rule in its own words: "Take the whole thing
 *      where you pass the whole thing on; name what you use where you use a few." A module that binds a
 *      parameter to the whole `Services`, reads a handful of members off it, and never hands it to anything
 *      else has declared a dependency on a hundred seams to use three, which is the surface its test has to
 *      stand up and the surface a change anywhere can reach it through. The ones that hand `services` on
 *      (route mounts, the turn, the capability handlers) are the exception the rule names, and are not listed.
 *
 *   2. A MUTUAL RUNTIME DEPENDENCY BETWEEN TWO SUBSYSTEMS. `agent` imports a value from `claude` and `claude`
 *      imports a value from `agent`. Type-only imports are excluded on purpose: they erase, they cannot make a
 *      module evaluate before its dependency, and the composition root's `Services` type reaching every module
 *      is by design. A VALUE cycle is the one that decides load order by accident, and the one that makes
 *      either side impossible to lift out (a provider into its own package, say) without taking the other.
 *      Files at the root of src/ (composition.ts, app.ts, main.ts, the route-*.testing.ts harness) are the
 *      composition root and are left out of the graph: reaching everything is their job.
 *
 * Read with regular expressions over import statements rather than a parser, for the reason lib/lockfile.mjs
 * gives: this runs from the pre-push hook and the CI preflight job, before any install, so it cannot import
 * one. An import statement is the flattest region of a TypeScript file, and a shape the scanner stops
 * recognizing shows up here as a count that moved, not as silence.
 *
 * Deliberately NOT checked: whether a `Pick<Services, …>` is the right width, or which direction a cycle should
 * be cut from. Both are design decisions; this only refuses to let either be made by omission. */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.filename, "../../..");
const src = join(root, "_sandbox/sandbox/src");

/* The modules that take `Services` whole and hand it to nothing, at the time this gate was written. Each is a
 * promise to name its seams (`Pick<Services, "config" | "git">`, or a local deps interface), not a licence:
 * removing an entry means narrowing the file. A module that starts handing `services` on drops out of the
 * shape and off this list by itself. Shrink this list; never grow it. */
const NARROW_TAKERS = new Set([
    "activity/outbound.ts",
    "agent/providers/adapter.ts",
    "agent/providers/provider-module.ts",
    "agent/run/turn-interactions.ts",
    "chores/chore-signals.ts",
    "runtimes/codex/codex-readiness.ts",
    "git/changes/diff-raw.ts",
    "intentic/check-run.ts",
    "personas/personas.routes.ts",
    "platform/sync-ssh.ts",
    "scaffold/ensure-intent.ts",
    "scaffold/starter-site.ts",
    "system/workspace-identity.ts",
    "workspace/layout/sync-repos.ts",
]);

/* The pairs of subsystems that import each other's VALUES, at the time this gate was written, `a <-> b` with
 * the names in sorted order. Cutting one means making one side reach the other through a type-only port, an
 * event, or a module that sits above both. Shrink this list; never grow it. */
const MUTUAL_PAIRS = new Set([
    "agent <-> runtimes/acp",
    "capabilities <-> runtimes/acp",
    "agent <-> agents",
    "agent <-> automations",
    "agent <-> browser",
    "agent <-> capabilities",
    "agent <-> runtimes/claude",
    "agent <-> runtimes/codex",
    "agent <-> runtimes/cursor",
    "agent <-> endpoints",
    "agent <-> engines",
    "agent <-> execution",
    "agent <-> extensions",
    "agent <-> runtimes/gemini",
    "agent <-> runtimes/grok",
    "agent <-> guard",
    "agent <-> runtimes/minted",
    "agent <-> runtimes/kimi",
    "agent <-> runtimes/pi",
    "agent <-> rules",
    "agent <-> runners",
    "agent <-> secrets",
    "agent <-> sessions",
    "agent <-> settings",
    "agent <-> system",
    "agent <-> terminal",
    "agents <-> loops",
    "agents <-> workflows",
    "agents <-> workspace",
    "auth <-> store",
    "automations <-> ci",
    "automations <-> extensions",
    "automations <-> issues",
    "browser <-> capabilities",
    "browser <-> platform",
    "browser <-> system",
    "capabilities <-> environment",
    "capabilities <-> extensions",
    "capabilities <-> hosts",
    "capabilities <-> settings",
    "engines <-> runtimes/claude",
    "environment <-> extensions",
    "git <-> history",
    "history <-> workspace",
    "personas <-> settings",
    "platform <-> system",
    "processes <-> system",
    "processes <-> terminal",
    "scaffold <-> workspace",
    "store <-> workspace",
    "system <-> terminal",
]);

const relPath = (file) => relative(src, file).split(sep).join("/");

/* `runtimes/` IS A SHELF, NOT A SUBSYSTEM. The nine agent runtimes on it (claude, codex, cursor, …) are
 * independent adapters that know nothing about each other; they sit in one directory so a listing of `src/`
 * says "these are the runtimes" instead of scattering nine sibling names through the alphabet. Reading the
 * shelf as one subsystem would merge their nine edge sets into one and invent cycles nobody wrote — `browser`
 * imports cursor's tools and gemini imports browser's, which is two one-way edges until something calls both
 * of them "runtimes". So the shelf's children are the subsystems, exactly as they were when they sat at the
 * top level, and every pair below keeps its meaning. */
const SHELVES = new Set(["runtimes"]);
const subsystemOf = (file) => {
    const parts = relPath(file).split("/");
    if (parts.length === 1) {
        return undefined;
    }
    return SHELVES.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
};

const sources = [];
const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(path);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            sources.push({ file: path, text: readFileSync(path, "utf8") });
        }
    }
};
walk(src);

const failures = [];

/* ---- 1. narrow takers ------------------------------------------------------------------------------------ */

// `x: Services` and `{ a, b }: Services` bind the whole interface. `Services["git"]` (an indexed member) and
// `Pick<Services, …>` do not, and `Services` as a generic argument elsewhere is somebody else's shape.
const WHOLE_BINDING = /([\w$]+)\s*:\s*Services(?![\w$[])/g;
const DESTRUCTURED_BINDING = /\{[^}]*\}\s*:\s*Services(?![\w$[])/;
const IMPORTS_SERVICES = /import\s+(?:type\s+)?\{[^}]*\bServices\b[^}]*\}\s*from\s*["'](?:\.\.\/)*composition\.js["']/;

const narrowTakers = new Set();
for (const { file, text } of sources) {
    if (!IMPORTS_SERVICES.test(text)) {
        continue;
    }
    const path = relPath(file);
    if (DESTRUCTURED_BINDING.test(text)) {
        // Destructuring the whole type is the narrow shape with the seams already named in the pattern, and a
        // test still has to build every other member to call it. No backlog: none did this when the gate landed.
        narrowTakers.add(path);
        continue;
    }
    const names = new Set([...text.matchAll(WHOLE_BINDING)].map((match) => match[1]));
    if (names.size === 0) {
        continue;
    }
    // "Hands it on": the bound name used as anything other than the left side of a member access or its own
    // declaration, a call argument, a spread, a property value, a return. One is enough to make the module an
    // orchestrator in composition.ts's sense.
    const handsOn = [...names].some((name) => {
        const escaped = name.replaceAll("$", "\\$");
        return new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])(?!\\s*[.:])`).test(text);
    });
    if (!handsOn) {
        narrowTakers.add(path);
    }
}

for (const path of narrowTakers) {
    if (!NARROW_TAKERS.has(path)) {
        failures.push(
            `${path} takes the whole Services and hands it to nothing: name the seams it reads (Pick<Services, …> or a local deps interface, composition.ts "WHAT A MODULE SHOULD TAKE OF IT")`,
        );
    }
}
const retired = [];
for (const path of NARROW_TAKERS) {
    if (!narrowTakers.has(path)) {
        retired.push(`NARROW_TAKERS names ${path}, which no longer takes Services whole (or no longer exists)`);
    }
}

/* ---- 2. mutual runtime dependencies ---------------------------------------------------------------------- */

// One statement per match: static imports and re-exports with a specifier, plus the dynamic form. The named
// list is captured so a `{ type A, type B }` list can be told from a value import without a parser.
const STATIC_IMPORT =
    /(?<![\w$.])(import|export)\s+(type\s+)?(?:(\*\s+as\s+[\w$]+|[\w$]+|\{[^}]*\})\s*(?:,\s*\{[^}]*\})?\s*from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g;

const isValueImport = (keyword, typeKeyword, clause) => {
    if (typeKeyword !== undefined) {
        return false;
    }
    if (clause === undefined) {
        // `import "./side-effect.js"` or `export * from`: both evaluate the module.
        return true;
    }
    if (!clause.startsWith("{")) {
        return true;
    }
    const specifiers = clause
        .slice(1, -1)
        .split(",")
        .map((specifier) => specifier.trim())
        .filter((specifier) => specifier !== "");
    return specifiers.some((specifier) => !specifier.startsWith("type "));
};

// subsystem -> Set<subsystem>, value edges only, root files excluded on both ends.
const edges = new Map();
const addEdge = (from, to) => {
    if (from === undefined || to === undefined || from === to) {
        return;
    }
    if (!edges.has(from)) {
        edges.set(from, new Set());
    }
    edges.get(from).add(to);
};
const targetSubsystem = (file, specifier) => {
    if (!specifier.startsWith(".")) {
        return undefined;
    }
    const target = resolve(join(file, ".."), specifier);
    return target.startsWith(src + sep) ? subsystemOf(target) : undefined;
};

for (const { file, text } of sources) {
    const from = subsystemOf(file);
    if (from === undefined) {
        continue;
    }
    for (const match of text.matchAll(STATIC_IMPORT)) {
        const [, keyword, typeKeyword, clause, specifier] = match;
        if (isValueImport(keyword, typeKeyword, clause)) {
            addEdge(from, targetSubsystem(file, specifier));
        }
    }
    for (const match of text.matchAll(DYNAMIC_IMPORT)) {
        addEdge(from, targetSubsystem(file, match[1]));
    }
}

const mutual = new Set();
for (const [from, targets] of edges) {
    for (const to of targets) {
        if (from < to && edges.get(to)?.has(from)) {
            mutual.add(`${from} <-> ${to}`);
        }
    }
}

for (const pair of mutual) {
    if (!MUTUAL_PAIRS.has(pair)) {
        failures.push(
            `${pair}: these two subsystems now import each other's values. Reach one way through a type-only port, an event, or a module above both`,
        );
    }
}
for (const pair of MUTUAL_PAIRS) {
    if (!mutual.has(pair)) {
        retired.push(`MUTUAL_PAIRS names '${pair}', which is no longer a cycle`);
    }
}
// Debt that has been paid: said, so the list gets trimmed when this file is next edited, and never a refusal.
for (const line of retired) {
    console.log(`verify-daemon-boundaries: ${line}: drop it from the list when you next edit this file`);
}

if (failures.length > 0) {
    console.error(`verify-daemon-boundaries: ${failures.length} problem(s)\n`);
    for (const failure of failures) {
        console.error(`  - ${failure}`);
    }
    process.exit(1);
}

console.log(
    `verify-daemon-boundaries: ok, ${narrowTakers.size} narrow takers of Services and ${mutual.size} mutual subsystem cycles, none new (${edges.size} subsystems, ${[...edges.values()].reduce((n, set) => n + set.size, 0)} runtime edges)`,
);
