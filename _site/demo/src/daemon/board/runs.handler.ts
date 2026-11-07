import type { DeviceRun, RunOutput } from "@intentic/sandbox-contract/schemas/run-targets";
import { DEMO_RUN_TARGETS } from "../account/settings";
import type { Doors } from "../doors";

// The Run view's computers. A start answers the terminal session the build and the launch run in, named as the daemon
// names a run's job session, for the editor to open. On ada-pc the shop's desktop app is running from a build three lands
// old (its Restart lights), its isolated twin fell over and is being built again, the workspace root's kiosk runs, and a
// program an agent started there with app_start, which no run.json names, runs beside them.

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
        startedBy: `the Run view`,
        builtFrom: { commit: `a91c3e2f04b7d15e`, changed: 4, at: new Date(AT - 120_000).toISOString() },
        landsSince: 3,
    },
    // Started by an agent's turn with app_start: no run.json names it, and the computer lists it all the same.
    {
        device: `ada-pc`,
        id: `price-sync-77aa01`,
        name: `price-sync.exe`,
        state: `running`,
        said: `running, pid 7020`,
        startedAt: new Date(AT - 2_700_000).toISOString(),
        ports: [],
        startedBy: `conversation "Supplier price sync"`,
    },
    // The workspace root's kiosk, started from the Run view twenty minutes ago and still up.
    {
        device: `ada-pc`,
        id: `kiosk-2d7e90`,
        name: `kiosk`,
        state: `running`,
        said: `running, pid 6312`,
        startedAt: new Date(AT - 1_200_000).toISOString(),
        repo: `root`,
        ports: [],
        startedBy: `the Run view`,
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
    // The running desktop app, followed again in a terminal of its own.
    attach: ({ repo, target, device }) => ({ session: `job-run-${repo}-${target}-${device}`.replaceAll(/[^a-zA-Z0-9-]/gu, `-`) }),
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
