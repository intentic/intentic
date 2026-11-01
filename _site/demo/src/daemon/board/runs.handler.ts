import type { DeviceRun, RunOutput } from "@intentic/sandbox-contract/schemas/run-targets";
import { DEMO_RUN_TARGETS } from "../account/settings";
import type { Doors } from "../doors";

// A repository's "Run on <device>" dialog. A start answers the terminal session the build and the launch run in, named as
// the daemon names a run's job session, for the editor to open. On ada-pc the shop's desktop app is running and its
// isolated twin fell over, so the dialog draws a running row (Stop, Restart, its log) and an ended one.

const AT = Date.UTC(2026, 9, 31, 9, 0);

const demoRuns = (): DeviceRun[] => [
    {
        device: `ada-pc`,
        id: `desktop-4f1c2a`,
        name: `desktop`,
        state: `running`,
        said: `running, pid 4120`,
        startedAt: new Date(AT).toISOString(),
        repo: `web`,
        ports: [7880],
    },
    {
        device: `ada-pc`,
        id: `desktop-isolated-9b0e11`,
        name: `desktop-isolated`,
        state: `ended`,
        said: `exited with code 101`,
        exitCode: 101,
        startedAt: new Date(AT - 3_600_000).toISOString(),
        endedAt: new Date(AT - 3_590_000).toISOString(),
        ports: [],
    },
];

const DEMO_LOG = [
    `shop 0.14.2 starting`,
    `loaded 312 products from the local cache`,
    `listening on 127.0.0.1:7880`,
    `client 127.0.0.1:52114 connected`,
    `GET /api/cart 200 3ms`,
];

export const runsDoors = {
    targets: () => DEMO_RUN_TARGETS,
    start: ({ repo, target, device }) => ({ session: `run-${repo}-${target}-${device}`.replaceAll(/[^a-zA-Z0-9_-]/gu, `-`) }),
    // desktop-isolated is being built again in its terminal, so its row offers that terminal and a Stop.
    active: ({ device }) => ({
        runs: demoRuns().filter((run) => run.device === device),
        terminals: device === `ada-pc` ? [{ repo: `web`, target: `desktop-isolated`, session: `job-run-web-desktop-isolated-ada-pc` }] : [],
    }),
    stop: ({ target, id }) => ({ stopped: [{ id: id ?? `${target}-4f1c2a`, text: `Stopped ${id ?? target}, with everything it started.` }] }),
    output: ({ id, since }) => {
        const run = demoRuns().find((entry) => entry.id === id);
        const total = DEMO_LOG.join(`\n`).length;
        const answer: RunOutput = { total, lines: since === undefined ? DEMO_LOG : [] };
        if (run !== undefined) {
            answer.run = run;
        }
        return answer;
    },
} satisfies Doors<`runs`>;
