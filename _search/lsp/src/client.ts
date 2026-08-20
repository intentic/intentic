import { resolve } from "node:path";
import { checkProject, type CheckPlacement, findTsconfig } from "./checker.js";
import type { DiagReport } from "./report.js";

/* The asking side, what the sandbox's post-edit hook imports.
 *
 * There is no resident service to find or to start anymore: every ask runs the native compiler to completion
 * and every byte comes back when it exits. What this module adds over `checkProject` is the shape of the
 * asking: agents edit in bursts (a rename touching six files lands as six PostToolUse hooks in a second), and
 * six edits to one package must not become six whole-project runs racing each other.
 *
 * SINGLE-FLIGHT, WITH ONE TRAILING RERUN. Per project (and per placement, two turns' namespaces are two
 * different trees by the same names), at most one compiler run is ever in flight. An ask that arrives while
 * one is running does not start another: it queues, pooling its files with every other ask that arrives in
 * the window, and ONE rerun after the current run settles answers the whole pool. The rerun is not optional,
 * the queued ask arrived because an edit just landed, and the in-flight run started before that edit, so its
 * answer is stale for the asker by construction.
 *
 * Imported by the sandbox daemon, so nothing here (or below it) pulls in anything but node builtins, the
 * compiler runs in the spawned process, never in the importer's heap. */

export type { CheckPlacement } from "./checker.js";
export type { Diagnostic, DiagReport, Unavailable } from "./report.js";

export interface DiagnoseOptions {
    readonly files: readonly string[];
    // Present when `files` are named for a view of the tree this process is not standing in, the compiler is
    // entered into that view, and answers in those same names.
    readonly placement?: CheckPlacement;
}

interface PooledAsk {
    files: Set<string>;
    settle: Promise<DiagReport>;
    resolve: (report: DiagReport) => void;
}

interface Flight {
    running: Promise<unknown>;
    queued: PooledAsk | undefined;
}

const flights = new Map<string, Flight>();

// Placement objects are per-turn; two placements are two namespaces even when the tsconfig path matches.
const placementIds = new WeakMap<CheckPlacement, number>();
let nextPlacementId = 1;
const flightKey = (tsconfig: string, placement: CheckPlacement | undefined): string => {
    if (placement === undefined) {
        return tsconfig;
    }
    let id = placementIds.get(placement);
    if (id === undefined) {
        id = nextPlacementId;
        nextPlacementId += 1;
        placementIds.set(placement, id);
    }
    return `${tsconfig}\0${id}`;
};

const runPooled = async (tsconfig: string, key: string, placement: CheckPlacement | undefined, files: readonly string[]): Promise<DiagReport> => {
    const report = await checkProject(tsconfig, files, placement);
    const flight = flights.get(key);
    const queued = flight?.queued;
    if (queued === undefined) {
        flights.delete(key);
    } else {
        flight!.queued = undefined;
        flight!.running = runPooled(tsconfig, key, placement, [...queued.files]).then(queued.resolve);
    }
    return report;
};

const checkCoalesced = (tsconfig: string, files: readonly string[], placement: CheckPlacement | undefined): Promise<DiagReport> => {
    const key = flightKey(tsconfig, placement);
    const flight = flights.get(key);
    if (flight === undefined) {
        const running = runPooled(tsconfig, key, placement, files);
        flights.set(key, { running, queued: undefined });
        return running;
    }
    if (flight.queued === undefined) {
        let deliver!: (report: DiagReport) => void;
        const settle = new Promise<DiagReport>((accept) => {
            deliver = accept;
        });
        flight.queued = { files: new Set(files), settle, resolve: deliver };
    } else {
        for (const file of files) {
            flight.queued.files.add(file);
        }
    }
    return flight.queued.settle;
};

// A pooled run answered for the union of everyone's files; each asker gets the slice it asked about.
const sliceFor = (report: DiagReport, files: readonly string[]): DiagReport => {
    const asked = new Set(files.map((file) => resolve(file)));
    return {
        diagnostics: report.diagnostics.filter((d) => asked.has(resolve(d.file))),
        unavailable: report.unavailable.filter((u) => asked.has(resolve(u.file))),
    };
};

// Diagnostics for these files, or undefined when there is no answer to be had at all: a file with no tsconfig
// above it belongs to no TypeScript project, and without a project there is no program to have an opinion.
// A returned report distinguishes verdicts from refusals, see report.ts, and keep them apart.
export const diagnose = async (options: DiagnoseOptions): Promise<DiagReport | undefined> => {
    const byProject = new Map<string, string[]>();
    for (const file of options.files) {
        const tsconfig = findTsconfig(file);
        if (tsconfig === undefined) {
            continue;
        }
        const group = byProject.get(tsconfig) ?? [];
        group.push(file);
        byProject.set(tsconfig, group);
    }
    if (byProject.size === 0) {
        return undefined;
    }
    const reports = await Promise.all(
        [...byProject.entries()].map(([tsconfig, files]) => checkCoalesced(tsconfig, files, options.placement).then((r) => sliceFor(r, files))),
    );
    return {
        diagnostics: reports.flatMap((r) => r.diagnostics),
        unavailable: reports.flatMap((r) => r.unavailable),
    };
};
