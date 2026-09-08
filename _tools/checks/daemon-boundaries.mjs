#!/usr/bin/env node
// Holds two shapes of daemon boundary drift to a backlog that may shrink and never grow (a new entry fails; a stale one
// is reported, not refused): a narrow taker of Services should name its seams, and a mutual value-import cycle between
// two subsystems should not exist. Read by regex over imports, since this runs pre-install.
// 1. NARROW_TAKERS: a module that binds the whole Services type, uses a few members, and hands it to nothing else.
// 2. MUTUAL_PAIRS: two subsystems importing each other's values (type-only imports don't count); composition-root files
//    are excluded.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.filename, "../../..");
const src = join(root, "_sandbox/sandbox/src");

// Snapshot of modules taking Services whole; each is a promise to narrow. Shrink this list; never grow it.
const NARROW_TAKERS = new Set([
    "activity/outbound.ts",
    "agent/providers/adapter.ts",
    "agent/providers/provider-module.ts",
    "agent/run/turn/turn-interactions.ts",
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

// Snapshot of value-import cycles, a <-> b sorted; cut via a type-only port, an event, or a module above both.
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

// runtimes/ is a shelf, not a subsystem: its adapters know nothing of each other, so each is its own subsystem.
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

// `x: Services` binds the whole interface; `Services["git"]`, `Pick<Services, ...>` and a generic argument do not.
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
        // Destructuring the whole type already names its seams in the pattern; no backlog entry has ever needed one.
        narrowTakers.add(path);
        continue;
    }
    const names = new Set([...text.matchAll(WHOLE_BINDING)].map((match) => match[1]));
    if (names.size === 0) {
        continue;
    }
    // "Hands it on": the bound name used as anything but a member access; one use makes it an orchestrator.
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

// One statement per match, static or dynamic; the named list reads a `{ type A, B }` clause without a parser.
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
