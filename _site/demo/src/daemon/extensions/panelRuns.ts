import type { PanelLaunch, PanelSummary } from "@intentic/sandbox-contract/schemas/panels";
import { refuse } from "@intentic/contract-serve";
import { pushRuntimeChanged } from "../broadcast";
import { okAfter } from "../doors";
import { repoPage } from "../workspace/appPage";

// Repositories' dev servers, started and stopped the way the daemon's process manager runs them: a start opens the
// repo's terminal (`panel-<repo>`), runs its dev command, and only once something listens does the row say it serves.
// Each step is pushed as `panels` and `terminals` move, so the rail, the Preview tab and the terminal list follow it.

// How long each launch step lasts, paced so the Preview tab's starting screen is read rather than flashed.
const STEPS: readonly { readonly launch: PanelLaunch; readonly ms: number }[] = [
    { launch: `launching`, ms: 900 },
    { launch: `starting`, ms: 2_400 },
];
const INSTALL_MS = 3_200;
// The port the sandbox hands a repo's dev server, from the range it gives panels.
const FIRST_PORT = 5173;

interface Run {
    launch: PanelLaunch | undefined;
    serving: boolean;
    readonly port: number;
    readonly timers: ReturnType<typeof setTimeout>[];
}

const runs = new Map<string, Run>();

/** The repository a preview host names, and whether its dev server answers yet, for the preview proxy (previewSites.ts). */
export const panelAt = (host: string): { readonly repo: string; readonly serving: boolean } | undefined => {
    const repo = [...runs.keys()].find((candidate) => new URL(repoPage(candidate)).host === host);
    return repo === undefined ? undefined : { repo, serving: runs.get(repo)?.serving === true };
};

/** The rows with what is running joined in, as `panels.list` answers them. */
export const withRuns = (rows: readonly PanelSummary[]): PanelSummary[] =>
    rows.map((row) => {
        const run = runs.get(row.repo);
        if (run === undefined) {
            return row;
        }
        const running: PanelSummary = { ...row, running: true, healthy: run.serving, installed: true, port: run.port, servers: [] };
        if (run.launch !== undefined) {
            running.launch = run.launch;
        }
        if (run.serving) {
            running.servers = [{ port: run.port, url: `http://localhost:${run.port}`, session: `panel-${row.repo}` }];
            running.previewUrl = repoPage(row.repo);
        }
        return running;
    });

const step = (run: Run, after: number, change: () => void): void => {
    run.timers.push(
        setTimeout(() => {
            change();
            pushRuntimeChanged(`panels`, `terminals`);
        }, after),
    );
};

// Starting one already running is a no-op, as the daemon's is; a repo with nothing to run is refused in its words.
export const startPanel = (rows: readonly PanelSummary[], repo: string) => {
    const row = rows.find((candidate) => candidate.repo === repo) ?? refuse(`no repository with that name`, 404);
    if (!row.hasPanel) {
        refuse(`${repo} has no runnable panel, add an operator/ dev server or a dev script`, 400);
    }
    return okAfter(() => {
        if (runs.has(repo)) {
            return;
        }
        const run: Run = { launch: `launching`, serving: false, port: FIRST_PORT + runs.size, timers: [] };
        runs.set(repo, run);
        const plan = row.installed ? STEPS : [STEPS[0], { launch: `installing` as const, ms: INSTALL_MS }, ...STEPS.slice(1)];
        let at = 0;
        for (const [index, current] of plan.entries()) {
            at += current?.ms ?? 0;
            const next = plan[index + 1];
            step(run, at, () => {
                run.launch = next?.launch;
                run.serving = next === undefined;
            });
        }
        pushRuntimeChanged(`panels`, `terminals`);
    });
};

export const stopPanel = (rows: readonly PanelSummary[], repo: string) => {
    if (!rows.some((candidate) => candidate.repo === repo)) {
        refuse(`no repository with that name`, 404);
    }
    return okAfter(() => {
        const run = runs.get(repo);
        if (run !== undefined) {
            run.timers.forEach(clearTimeout);
            runs.delete(repo);
            pushRuntimeChanged(`panels`, `terminals`);
        }
    });
};
