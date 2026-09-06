import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import type { ManagedProcesses } from "../processes/managed-processes.js";
import type { ServiceProcesses, ServiceStatus } from "../processes/service-processes.js";
import { workspacePaths } from "../workspace/workspace.js";

/* The route harness's recording fakes: the two process supervisors, the history and files seams with every
 * member inert unless a suite overrides it, and a temp workspace for the suites that drive repo discovery.
 * `services` (route-services.testing.ts) composes the inert ones. Not part of the build (tsconfig excludes
 * `*.testing.ts`), type-checked with the tests (tsconfig.test.json). */

// The service supervisor's fake, same recording shape as fakeProcesses below: seeded keys read as running
// services on the seeded port.
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
            // A stubbed panel is never mid-start: the routes drop the field, which is also the common case.
            launchOf: () => undefined,
            stopAll: () => {},
        }),
        { started, stopped },
    );
};

// A temp workspace on disk (repo discovery reads it): each entry names a repo, a dir owning a .git, role and
// clone alike, and whether it gets an operator/ panel (a package.json with a dev script).
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
