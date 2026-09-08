import { resolve } from "node:path";
import { checkProject, type CheckPlacement, findTsconfig } from "./checker.js";
import type { DiagReport } from "./report.js";

// Asking side the sandbox's post-edit hook imports; no resident service, every ask runs the compiler to completion.
// Single-flight per project (and per placement): a burst of asks pools into one run plus one trailing rerun for what
// queued.
// Pulls in only node builtins; the compiler runs in the spawned process, not this one's heap.

export type { CheckPlacement } from "./checker.js";
export type { Diagnostic, DiagReport, Unavailable } from "./report.js";

export interface DiagnoseOptions {
    readonly files: readonly string[];
    // Set when `files` name a tree view this process isn't standing in; the compiler is entered into it.
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

// Placement objects are per-turn; two placements are two namespaces even with the same tsconfig path.
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

// A pooled run answers for the union of files asked; slice each asker's report to its own files.
const sliceFor = (report: DiagReport, files: readonly string[]): DiagReport => {
    const asked = new Set(files.map((file) => resolve(file)));
    return {
        diagnostics: report.diagnostics.filter((d) => asked.has(resolve(d.file))),
        unavailable: report.unavailable.filter((u) => asked.has(resolve(u.file))),
    };
};

// Diagnostics for `files`, or undefined if none of them sit under a tsconfig project.
// A report distinguishes verdicts from refusals per file.
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
