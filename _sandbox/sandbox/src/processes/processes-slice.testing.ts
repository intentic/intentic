import { unstubbed } from "@intentic/testing";
import { createTerminalRunner } from "../terminal/terminal-run.js";
import type { ManagedProcesses } from "./managed-processes.js";
import type { ProcessesSlice } from "./processes-slice.js";
import type { ServiceProcesses, ServiceStatus } from "./service-processes.js";

// The processes slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// Same recording shape as fakeProcesses; seeded keys read as running services on the seeded port.
export const fakeServiceProcesses = (
    ports: Record<string, number> = {},
): ServiceProcesses & { started: { key: string; cwd: string }[]; stopped: string[] } => {
    const started: { key: string; cwd: string }[] = [];
    const stopped: string[] = [];
    const statusOf = (key: string): ServiceStatus | undefined =>
        key in ports ? { key, state: "running", port: ports[key] ?? 0, restarts: 0, since: 0 } : undefined;
    return Object.assign(
        unstubbed<ServiceProcesses>("serviceProcesses", {
            start: async (key, spec) => {
                started.push({ key, cwd: spec.cwd });
            },
            stop: (key) => {
                stopped.push(key);
            },
            running: (key) => key in ports,
            portOf: (key) => ports[key],
            statusOf,
            list: () => Object.keys(ports).flatMap((key) => statusOf(key) ?? []),
            logPathOf: () => undefined,
            stopAll: () => {},
        }),
        { started, stopped },
    );
};

// Records starts/stops; `portOf` returns the seeded port so a repo reads as running (the list route derives
// running/healthy from portOf, not running()).
export const fakeProcesses = (
    ports: Record<string, number> = {},
): ManagedProcesses & { started: { repo: string; cwd: string }[]; stopped: string[] } => {
    const started: { repo: string; cwd: string }[] = [];
    const stopped: string[] = [];
    return Object.assign(
        unstubbed<ManagedProcesses>("processes", {
            start: async (repo, spec) => {
                started.push({ repo, cwd: spec.cwd });
            },
            stop: (repo) => {
                stopped.push(repo);
            },
            running: (repo) => repo in ports,
            portOf: (repo) => ports[repo],
            // A stubbed panel is never mid-start; routes drop the field, which is also the common case.
            launchOf: () => undefined,
            // Nor is it a one-shot run: a test that wants a finished install or check says so by replacing this.
            runOf: () => undefined,
            stopAll: () => {},
        }),
        { started, stopped },
    );
};

export const processesSliceFake = () =>
    ({
        processes: fakeProcesses(),
        serviceProcesses: fakeServiceProcesses(),
        // Empty so tests opt into listeners explicitly. `portForwards` is composed by the harness, since ports already
        // reaches this subsystem.
        scanPorts: async () => [],
        terminalRun: createTerminalRunner(),
    }) satisfies Partial<ProcessesSlice>;
