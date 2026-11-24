import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "../sync/exec.js";
import { FleetConfigSchema, type FleetConfig } from "./config.js";
import { createFleetContext, type FleetContext } from "./context.js";
import type { FleetSys } from "./sys.js";

/* A FAKE COMPUTER FOR THE FLEET'S TESTS: programs answer by a function of their command line, files, folders and links
   are maps, the clock is a number the test moves. Every program call is recorded, so a test asserts what would have
   run (a `systemctl stop` of exactly one unit) without a systemd. */

export const exec = (stdout: string, status: number | null = 0, stderr = ""): ExecResult => ({ status, stdout, stderr });

export interface FakeComputer {
    // A program's answer by its command line; undefined is "not found" (exit 127).
    programs?: (command: string, args: readonly string[]) => ExecResult | undefined;
    files?: Map<string, string>;
    dirs?: Map<string, string[]>;
    links?: Map<string, string>;
    now?: number;
}

export interface FakeSys extends FleetSys {
    readonly calls: string[][];
    readonly computer: FakeComputer;
}

export const fakeSys = (computer: FakeComputer = {}): FakeSys => {
    const calls: string[][] = [];
    return {
        calls,
        computer,
        run: async (command, args) => {
            calls.push([command, ...args]);
            return (await Promise.resolve(computer.programs?.(command, args))) ?? exec("", 127, `${command}: not found`);
        },
        readText: async (path) => await Promise.resolve(computer.files?.get(path)),
        readHead: async (path, bytes) => await Promise.resolve(computer.files?.get(path)?.slice(0, bytes)),
        list: async (path) => await Promise.resolve(computer.dirs?.get(path)),
        readLink: async (path) => await Promise.resolve(computer.links?.get(path)),
        now: () => computer.now ?? Date.parse("2026-11-24T12:00:00Z"),
    };
};

export const tempDir = (prefix = "ci-fleet-"): string => mkdtempSync(join(tmpdir(), prefix));

// Settings over a fresh temp state folder and cache root, with whatever a test changes on top.
export const testConfig = (overrides: Partial<FleetConfig> = {}): FleetConfig =>
    FleetConfigSchema.parse({ user: "runner", stateDir: tempDir("ci-fleet-state-"), cacheRoot: tempDir("ci-fleet-cache-"), ...overrides });

export interface TestContext {
    readonly context: FleetContext;
    readonly lines: string[];
}

export const testContext = async (sys: FleetSys, config: FleetConfig = testConfig()): Promise<TestContext> => {
    const lines: string[] = [];
    const context = await createFleetContext(config, sys, (line) => lines.push(line), "1.500.0");
    return { context, lines };
};

// What systemd and the process table say of a fleet of runners: `runners` by unit name → its folder, state, worker pid.
export interface FakeRunner {
    readonly unit: string;
    readonly dir: string;
    readonly state?: string;
    readonly user?: string;
    readonly name?: string;
    readonly worker?: number;
    readonly elapsed?: number;
    readonly dropIns?: string;
}

// The program answers of a computer with these runners; `extra` answers anything else first.
export const runnerPrograms =
    (runners: readonly FakeRunner[], extra?: (command: string, args: readonly string[]) => ExecResult | undefined) =>
    (command: string, args: readonly string[]): ExecResult | undefined => {
        const answer = extra?.(command, args);
        if (answer !== undefined) {
            return answer;
        }
        if (command === "systemctl" && args[0] === "list-unit-files") {
            return exec(runners.map((runner) => `${runner.unit} enabled enabled\n`).join(""));
        }
        if (command === "systemctl" && args[0] === "show") {
            const asked = args.filter((arg) => arg.startsWith("actions.runner."));
            return exec(
                asked
                    .map((unit) => runners.find((runner) => runner.unit === unit))
                    .filter((runner) => runner !== undefined)
                    .map((runner) => `Id=${runner.unit}\nActiveState=${runner.state ?? "active"}\nWorkingDirectory=${runner.dir}\nUser=${runner.user ?? "runner"}\nDropInPaths=${runner.dropIns ?? ""}\n`)
                    .join("\n"),
            );
        }
        if (command === "pgrep") {
            const busy = runners.filter((runner) => runner.worker !== undefined);
            return busy.length === 0 ? exec("", 1) : exec(busy.map((runner) => `${runner.worker} ${runner.dir}/bin.2.329.0/Runner.Worker spawnclient 101 104\n`).join(""));
        }
        if (command === "ps") {
            return exec(
                runners
                    .filter((runner) => runner.worker !== undefined)
                    .map((runner) => `${runner.worker} ${runner.elapsed ?? 60}\n`)
                    .join(""),
            );
        }
        if (command === "systemctl" && (args[0] === "start" || args[0] === "stop")) {
            return exec("");
        }
        return undefined;
    };

// Each runner's `.runner` file, as config.sh writes it (with .NET's byte-order mark).
export const runnerFiles = (runners: readonly FakeRunner[]): Map<string, string> =>
    new Map(
        runners
            .filter((runner) => runner.name !== undefined)
            .map((runner) => [
                join(runner.dir, ".runner"),
                `﻿${JSON.stringify({ agentId: 7, agentName: runner.name, poolId: 1, gitHubUrl: "https://github.com/intentic/intentic", workFolder: "_work" })}`,
            ]),
    );
