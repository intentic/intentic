#!/usr/bin/env node
// Daemon boundary drift, read by pattern since this runs pre-install: a module binding the whole Services it hands to
// nothing (NARROW_TAKERS), a value import between subsystems closing a cycle of any length (baselined, may only shrink:
// baselines/daemon-cycles.json), and a Claude Agent SDK value taken around its loader or a diagnostic report asked for.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { addEdge, cyclesOf } from "./lib/cycle-edges.mjs";
import { importsOf } from "./lib/imports.mjs";
import { ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

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

/* ---- 2. the Claude Agent SDK's one door --------------------------------------------------------------------- */

// The loader names the CLI binary on every session; the SDK's own pick calls process.report.getReport(), which waits for
// every worker thread to answer and so holds the loop for as long as one sits in a SQLite statement.
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const SDK_DOOR = "engines/claude-sdk.ts";
const REPORT_CALL = /(?<![\w$])process\.report\.getReport\s*\(/;
// A comment may name the call; only code makes it.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

const sdkBypasses = sources.flatMap(({ file, text }) =>
    relPath(file) === SDK_DOOR
        ? []
        : importsOf(text)
              .filter(({ specifier, typeOnly }) => specifier === SDK_PACKAGE && !typeOnly)
              .map(({ line }) => `${relPath(file)}:${line} imports a value from ${SDK_PACKAGE}`),
);
const reportCalls = sources.flatMap(({ file, text }) =>
    text
        .split("\n")
        .flatMap((line, at) => (!COMMENT_LINE.test(line) && REPORT_CALL.test(line) ? [`${relPath(file)}:${at + 1} calls process.report.getReport()`] : [])),
);

/* ---- 3. cycles between subsystems ------------------------------------------------------------------------ */

// from -> to -> every `file:line` that makes the edge: value imports only, root files excluded on both ends.
const edges = new Map();
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
            addEdge(edges, from, targetSubsystem(file, specifier), `${relPath(file)}:${line}`);
        }
    }
}

const { nodes, cycleEdges, closes } = cyclesOf(edges);

// Each baseline key is one standing edge, its value the reason it stands ("" where none was recorded).
// An edge stops closing a cycle when any edge on its way back goes, so any daemon source a land changed can lower one.
const { grown: newEdges } = ratchet("daemon-boundaries", "daemon-cycles", new Map([...cycleEdges.keys()].map((edge) => [edge, 1])), {
    touchedBy: (_edge, path) => path.startsWith("_sandbox/sandbox/src/"),
});
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
        [
            `Claude Agent SDK code reached around engines/claude-sdk.ts, or a diagnostic report asked for (paths under _sandbox/sandbox/src/). Read the SDK through sdk(), which names the CLI binary on every session: a report waits for every worker thread, and held the loop 8 s at boot`,
            [...sdkBypasses, ...reportCalls],
        ],
    ],
    [
        `daemon-boundaries: ${narrowTakers.size} narrow takers of Services and ${cycleEdges.size} value edges closing cycles among ${cycleSubsystems.size} subsystems, none new (${nodes.length} subsystems, ${edgeCount} value edges)`,
    ],
);
