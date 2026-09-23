#!/usr/bin/env node
// Daemon boundary drift, held to a backlog that may shrink and never grow, read by pattern since this runs pre-install:
// a module that binds the whole Services and hands it to nothing (NARROW_TAKERS), and a value import between subsystems
// whose target already reaches back to its source, a cycle of any length (the standing ones: baselines/daemon-cycles.json).

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { importsOf } from "./lib/imports.mjs";
import { ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";
import { stronglyConnected } from "./lib/strongly-connected.mjs";

const src = join(root, "_sandbox/sandbox/src");
const BASELINE_PATH = "_tools/checks/baselines/daemon-cycles.json";

// Modules that bind the whole Services and hand it to nothing: none are left, so a new one fails until it names its
// seams.
const NARROW_TAKERS = new Set();

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

/* ---- 1. narrow takers ------------------------------------------------------------------------------------ */

// `x: Services` binds the whole interface; `Services["git"]`, `Pick<Services, ...>` and a generic argument do not.
const WHOLE_BINDING = /([\w$]+)\s*:\s*Services(?![\w$[])/g;
const DESTRUCTURED_BINDING = /\{[^}]*\}\s*:\s*Services(?![\w$[])/;
const IMPORTS_SERVICES = /import\s+(?:type\s+)?\{[^}]*\bServices\b[^}]*\}\s*from\s*["'](?:\.\.\/)*composition\.js["']/;

// "Hands it on": the bound name used as anything but a member access; one use makes it an orchestrator.
const handsOn = (text, names) =>
    [...names].some((name) => {
        const escaped = name.replaceAll("$", "\\$");
        return new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])(?!\\s*[.:])`).test(text);
    });

const takesWhole = (text) => {
    if (!IMPORTS_SERVICES.test(text)) {
        return false;
    }
    // Destructuring the whole type already names its seams in the pattern; no backlog entry has ever needed one.
    if (DESTRUCTURED_BINDING.test(text)) {
        return true;
    }
    const names = new Set([...text.matchAll(WHOLE_BINDING)].map((match) => match[1]));
    return names.size > 0 && !handsOn(text, names);
};

const narrowTakers = new Set(sources.filter(({ text }) => takesWhole(text)).map(({ file }) => relPath(file)));
const newTakers = [...narrowTakers]
    .filter((path) => !NARROW_TAKERS.has(path))
    .map((path) => `${path} takes the whole Services and hands it to nothing`);
// Debt that has been paid: said, so the list gets trimmed when this file is next edited, and never a refusal.
for (const path of NARROW_TAKERS) {
    if (!narrowTakers.has(path)) {
        console.log(
            `daemon-boundaries: NARROW_TAKERS names ${path}, which no longer takes Services whole (or no longer exists): drop it from the list when you next edit this file`,
        );
    }
}

/* ---- 2. cycles between subsystems ------------------------------------------------------------------------ */

// from -> to -> every `file:line` that makes the edge: value imports only, root files excluded on both ends.
const edges = new Map();
const addEdge = (from, to, site) => {
    if (from === undefined || to === undefined || from === to) {
        return;
    }
    const targets = edges.get(from) ?? edges.set(from, new Map()).get(from);
    (targets.get(to) ?? targets.set(to, []).get(to)).push(site);
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
    for (const { specifier, typeOnly, line } of from === undefined ? [] : importsOf(text)) {
        if (!typeOnly) {
            addEdge(from, targetSubsystem(file, specifier), `${relPath(file)}:${line}`);
        }
    }
}

// Sorted, so a component, a path back and every message come out the same on every run.
const targetsOf = (node) => [...(edges.get(node)?.keys() ?? [])].sort();
const nodes = [...new Set([...edges.keys(), ...[...edges.values()].flatMap((targets) => [...targets.keys()])])].sort();
const componentOf = new Map();
for (const component of stronglyConnected(nodes, targetsOf)) {
    for (const node of component) {
        componentOf.set(node, component);
    }
}

// An edge closes a cycle exactly when its two ends share a component, which is the target reaching back to the source.
const cycleEdges = new Map();
for (const [from, targets] of edges) {
    for (const to of targets.keys()) {
        if (componentOf.get(from) === componentOf.get(to)) {
            cycleEdges.set(`${from} -> ${to}`, [from, to]);
        }
    }
}

// The shortest way from `to` back to `from`, breadth first: [to, …, from].
const wayBack = (from, to) => {
    const previous = new Map([[to, undefined]]);
    const queue = [to];
    while (queue.length > 0 && !previous.has(from)) {
        const node = queue.shift();
        for (const next of targetsOf(node).filter((candidate) => !previous.has(candidate))) {
            previous.set(next, node);
            queue.push(next);
        }
    }
    const path = [];
    for (let node = from; node !== undefined; node = previous.get(node)) {
        path.unshift(node);
    }
    return path;
};

const sitesOf = (from, to) => edges.get(from).get(to);
// One `file:line` per importing file, the first import in it.
const filesOf = (from, to) => [...new Map(sitesOf(from, to).map((site) => [site.replace(/:\d+$/, ""), site])).values()];
const closes = ([from, to]) => {
    const back = wayBack(from, to);
    const hops = back.slice(1).map((node, at) => `${back[at]} -> ${node} (${sitesOf(back[at], node)[0]})`);
    const files = filesOf(from, to);
    const more = files.length > 3 ? ` and ${files.length - 3} more files` : "";
    return `${from} -> ${to} closes ${[from, ...back].join(" -> ")}: imported at ${files.slice(0, 3).join(", ")}${more}; the way back is ${hops.join(", ")}`;
};

// Each baseline key is one standing edge, its value the reason it stands ("" where none was recorded).
const { grown: newEdges } = ratchet("daemon-boundaries", "daemon-cycles", new Map([...cycleEdges.keys()].map((edge) => [edge, 1])));
const addedCycles = newEdges
    .map(({ key }) => key)
    .sort()
    .map((edge) => closes(cycleEdges.get(edge)));

const cycleSubsystems = new Set([...cycleEdges.values()].flat());
const edgeCount = [...edges.values()].reduce((count, targets) => count + targets.size, 0);
finish(
    [
        [
            `A module takes the whole Services and hands it to nothing (paths under _sandbox/sandbox/src/): name the seams it reads, Pick<Services, …> or a local deps interface (composition.ts, "WHAT A MODULE SHOULD TAKE OF IT")`,
            newTakers,
        ],
        [
            `A value import between daemon subsystems closes a cycle ${BASELINE_PATH} does not hold (paths under _sandbox/sandbox/src/). Reach one way through a type-only port, an event, or a module above both`,
            addedCycles,
        ],
    ],
    [
        `daemon-boundaries: ${narrowTakers.size} narrow takers of Services and ${cycleEdges.size} value edges closing cycles among ${cycleSubsystems.size} subsystems, none new (${nodes.length} subsystems, ${edgeCount} value edges)`,
    ],
);
