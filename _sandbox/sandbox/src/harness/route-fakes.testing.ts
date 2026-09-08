import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import type { ServiceProcesses, ServiceStatus } from "../processes/service-processes.js";
import { workspacePaths } from "../workspace/workspace.js";

// Route harness's recording fakes: the two process supervisors, inert history/files seams a test overrides selectively,
// and a temp workspace for repo-discovery suites. `services` composes the inert ones.

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
            stopAll: () => {},
        }),
        { started, stopped },
    );
};

// A temp workspace on disk for repo discovery: each entry is a repo dir with a `.git`, optionally an operator/ panel
// (package.json with a dev script).
export const tempWorkspace = (repos: { name: string; panel?: boolean }[]): ReturnType<typeof workspacePaths> => {
    const root = mkdtempSync(join(tmpdir(), "panels-"));
    for (const repo of repos) {
        const dir = join(root, repo.name);
        mkdirSync(join(dir, ".git"), { recursive: true });
        if (repo.panel === true) {
            mkdirSync(join(dir, "operator"), { recursive: true });
            writeFileSync(join(dir, "operator", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
        }
    }
    return workspacePaths(root);
};

// Inert history, no snapshots recorded, every id unknown; a test overrides just the members it asserts on.
export const fakeHistory = (overrides: Partial<Services["history"]> = {}): Services["history"] =>
    unstubbed("history", {
        start: () => {},
        stop: () => {},
        snapshot: async () => undefined,
        notifyUserWrite: () => {},
        list: async () => [],
        diff: async () => undefined,
        fileDiff: async () => undefined,
        restore: async () => false,
        ...overrides,
    });

// The files seam with every method a no-op by default; a test overrides just the ones it asserts on.
export const fakeFiles = (overrides: Partial<Services["files"]> = {}): Services["files"] =>
    unstubbed("files", {
        read: async () => undefined,
        readWindow: async () => undefined,
        write: async () => {},
        writeStream: async () => {},
        readBytes: async () => undefined,
        size: async () => undefined,
        mkdir: async () => {},
        remove: async () => {},
        move: async () => {},
        copy: async () => {},
        ...overrides,
    });
