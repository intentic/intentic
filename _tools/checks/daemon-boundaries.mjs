#!/usr/bin/env node
// Daemon boundary drift, read by pattern since this runs pre-install: a module binding the whole Services it hands to
// nothing (NARROW_TAKERS); a value import reaching a higher layer than its own (lib/daemon-layers.mjs, baselined, may only
// shrink: baselines/daemon-layers.json); a value import between subsystems of one layer closing a cycle of any length
// (baselined, may only shrink: baselines/daemon-cycles.json); and a Claude Agent SDK value taken around its loader or a
// diagnostic report asked for.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { daemonGraphs } from "./lib/daemon-graph.mjs";
import { importsOf } from "./lib/imports.mjs";
import { ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

const src = join(root, "_sandbox/sandbox/src");
const BASELINE_PATH = "_tools/checks/baselines/daemon-cycles.json";
const LAYERS_BASELINE_PATH = "_tools/checks/baselines/daemon-layers.json";

// Modules that bind the whole Services and hand it to nothing: none are left, so a new one fails until it names its
// seams.
const NARROW_TAKERS = new Set();

const relPath = (file) => relative(src, file).split(sep).join("/");

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

/* ---- 3. layers, and cycles within one --------------------------------------------------------------------- */

// Value imports only, root files excluded on both ends, route and testing modules as the surface above every layer.
const { cycles, upward, upwardSites, unplaced, valueEdges } = daemonGraphs(src, sources);
const { nodes, cycleEdges, closes } = cycles;

// Each key is one standing `from -> to`, counted in import sites. Any daemon source a land changed can lower one.
const { grown: grownUpward } = ratchet("daemon-boundaries", "daemon-layers", upward, {
    touchedBy: (_key, path) => path.startsWith("_sandbox/sandbox/src/"),
});
const addedUpward = grownUpward
    .map(({ key }) => key)
    .sort()
    .map((key) => `${key} (${(upwardSites.get(key) ?? []).slice(0, 3).join(", ")}${(upwardSites.get(key)?.length ?? 0) > 3 ? ", …" : ""})`);
const unplacedDirs = [...unplaced].sort().map((dir) => `src/${dir}/ is in no layer`);

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
const upwardSiteCount = [...upward.values()].reduce((sum, count) => sum + count, 0);
finish(
    [
        [
            `A module takes the whole Services and hands it to nothing (paths under _sandbox/sandbox/src/): name the seams it reads, Pick<Services, …> or a local deps interface (composition.ts, "WHAT A MODULE SHOULD TAKE OF IT")`,
            newTakers,
        ],
        [
            `A daemon directory is in no layer (paths under _sandbox/sandbox/src/). Add it to the layer it belongs to in _sandbox/sandbox/layers.json`,
            unplacedDirs,
        ],
        [
            `A value import reaches a higher layer than its own more often than ${LAYERS_BASELINE_PATH} holds (paths under _sandbox/sandbox/src/; the layers are _sandbox/sandbox/layers.json). Move what both need down, take it as a port the higher layer fills (a type in seams/ or a deps interface), or move a helper out of the route or testing module it sits in`,
            addedUpward,
        ],
        [
            `A value import between daemon subsystems of one layer closes a cycle ${BASELINE_PATH} does not hold (paths under _sandbox/sandbox/src/). Reach one way through a type-only port, an event, or a module above both`,
            addedCycles,
        ],
        [
            `Claude Agent SDK code reached around engines/claude-sdk.ts, or a diagnostic report asked for (paths under _sandbox/sandbox/src/). Read the SDK through sdk(), which names the CLI binary on every session: a report waits for every worker thread, and held the loop 8 s at boot`,
            [...sdkBypasses, ...reportCalls],
        ],
    ],
    [
        `daemon-boundaries: ${narrowTakers.size} narrow takers of Services, ${upwardSiteCount} upward imports across ${upward.size} edges and ${cycleEdges.size} same-layer edges closing cycles among ${cycleSubsystems.size} subsystems, none new (${nodes.length} subsystems in cycles' reach, ${valueEdges} value imports between subsystems)`,
    ],
);
