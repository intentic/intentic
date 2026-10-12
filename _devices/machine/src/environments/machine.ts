import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { execBounded, runBounded } from "@intentic/base/process";
import { STATE_DIR } from "@intentic/constants";
import { writeSecretFile } from "@intentic/local-agent";
import { wslPathOf } from "@intentic/sandbox-contract";
import { baseDir, machineConfigPath } from "../config.js";
import { registeredDistro, WINDOWS_SIDE } from "./wsl.js";
import { crossEnv } from "./crossing.js";

// A PC is one version and one supervisor tree: its Windows side is the root, and every distro with an agent is its child.

// Set by the Windows side on the agent it runs in a distro: that process has a supervisor, so it registers none.
export const SUPERVISOR_ENV = "INTENTIC_MACHINE_SUPERVISOR";
export const WINDOWS_SUPERVISOR = "windows";
export const supervisedByWindows = (env: NodeJS.ProcessEnv = process.env): boolean => env[SUPERVISOR_ENV] === WINDOWS_SUPERVISOR;

// Absent switches are on; `children` names distros by WSL registration name; `upgradeFailure` paces retries of one target.
// `sandboxKeeper` is this environment's own (`intentic-machine sandbox keeper`), not the PC's: it acts on the sandboxes
// this environment's ic keeps records of, which no other environment of the PC can see.
// `skippedAgent` is a release whose agent kept stopping here and was rolled back from (agent-trial.ts): no upgrade
// moves this environment onto it again, only a newer one.
export interface MachineConfig {
    readonly children?: readonly string[];
    readonly agentUpdates?: boolean;
    readonly sandboxUpdates?: boolean;
    readonly sandboxBackups?: boolean;
    readonly sandboxTidy?: boolean;
    readonly sandboxKeeper?: boolean;
    // Minutes a sandbox this environment keeps goes unneeded before the keeper puts it to sleep (sandbox-rounds/sleep.ts);
    // absent is the default, 0 never.
    readonly sandboxSleepMinutes?: number;
    readonly upgradeFailure?: { readonly target: string; readonly count: number; readonly at: number };
    readonly skippedAgent?: { readonly version: string; readonly at: number };
}

// A missing file is a machine that has never been configured; one that will not parse is a fault and propagates.
export const readMachineConfig = async (): Promise<MachineConfig> => {
    const raw = await readFile(machineConfigPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    });
    return raw === undefined ? {} : (JSON.parse(raw) as MachineConfig);
};

export const updateMachineConfig = async (mutate: (config: MachineConfig) => MachineConfig): Promise<MachineConfig> => {
    const next = mutate(await readMachineConfig());
    await writeSecretFile(machineConfigPath, baseDir, JSON.stringify(next, undefined, 2));
    return next;
};

export const childrenOf = (config: MachineConfig): readonly string[] => config.children ?? [];

// The distros this environment keeps running; anywhere but the Windows side that is none, and the config is not read.
export const heldDistros = async (): Promise<readonly string[]> => (WINDOWS_SIDE ? childrenOf(await readMachineConfig()) : []);

export const withChild = (config: MachineConfig, distro: string): MachineConfig =>
    childrenOf(config).includes(distro) ? config : { ...config, children: [...childrenOf(config), distro].toSorted() };

export const withoutChild = (config: MachineConfig, distro: string): MachineConfig => {
    const children = childrenOf(config).filter((held) => held !== distro);
    const { children: _gone, ...rest } = config;
    return children.length === 0 ? rest : { ...rest, children };
};

// interop runs a Windows program with the WSL cwd translated; a drive folder spares cmd.exe its UNC-path complaint.
const INTEROP_CWD = "/mnt/c";
const interopCwd = (): string | undefined => (existsSync(INTEROP_CWD) ? INTEROP_CWD : undefined);

const CMD_EXE = ["cmd.exe", "/mnt/c/Windows/System32/cmd.exe"];

const windowsProfile = async (): Promise<string | undefined> => {
    for (const cmd of CMD_EXE) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- candidates in order, the first that answers wins
        const answer = await execBounded(cmd, ["/c", "echo %USERPROFILE%"], { timeoutMs: 10_000, cwd: interopCwd() }).catch(() => undefined);
        const profile = answer?.stdout.trim();
        if (profile !== undefined && /^[A-Za-z]:\\/.test(profile)) {
            return profile;
        }
    }
    return undefined;
};

const linuxPathOf = async (windowsPath: string): Promise<string | undefined> => {
    const answer = await execBounded("wslpath", ["-u", windowsPath], { timeoutMs: 5_000 }).catch(() => undefined);
    const mapped = answer?.stdout.trim();
    return mapped === undefined || mapped === "" ? wslPathOf(windowsPath) : mapped;
};

// From a distro: the Windows side's installed agent through interop, or undefined where there is none to reach.
let root: Promise<string | undefined> | undefined;
export const windowsRoot = (): Promise<string | undefined> =>
    (root ??= (async () => {
        if ((await registeredDistro()) === undefined) {
            return undefined;
        }
        const profile = await windowsProfile();
        const home = profile === undefined ? undefined : await linuxPathOf(profile);
        const agent = home === undefined ? undefined : posix.join(home, STATE_DIR, "machine", "bin", "intentic-machine.exe");
        return agent !== undefined && existsSync(agent) ? agent : undefined;
    })());

// How long the Windows side's agent may take to answer a question from a distro (its version, whether it takes this
// distro over). WSL interop starts it cold, which on a loaded laptop takes seconds, not a minute; past that it is
// wedged, and this side carries on as though there were no Windows agent rather than waiting on it.
const WINDOWS_ASK_TIMEOUT_MS = 60_000;

// What a command handed this terminal may take. The longest is the Windows side's upgrade of every environment on the
// PC, downloads included; the bound is there so a wedged one ends rather than holding the terminal for good.
const WINDOWS_HANDOFF_TIMEOUT_MS = 30 * 60_000;

// Asks the Windows side's agent from a distro and reads its answer; `vars` cross by WSLENV. Not blocking, and the
// deadline ends what the interop started with it, so a Windows agent that never answers costs this side a minute.
export const runOnWindows = async (
    agent: string,
    args: readonly string[],
    { vars = {} }: { readonly vars?: Readonly<Record<string, string>> } = {},
): Promise<{ readonly status: number; readonly output: string }> => {
    const result = await runBounded(agent, args, { cwd: interopCwd(), env: crossEnv(vars, "w"), timeoutMs: WINDOWS_ASK_TIMEOUT_MS });
    return { status: result.exitCode ?? 1, output: `${result.stdout.text}${result.stderr.text}`.trim() };
};

// Hands this terminal to the Windows side's agent, which draws its own answer and its own stop on it, and answers its
// exit code. Blocking, and in this process's own group, so the person's Ctrl-C reaches it; with the terminal as its
// output nothing it leaves behind can hold a pipe open.
export const handToWindows = (agent: string, args: readonly string[]): number =>
    spawnSync(agent, [...args], { cwd: interopCwd(), env: crossEnv({}, "w"), stdio: "inherit", windowsHide: true, timeout: WINDOWS_HANDOFF_TIMEOUT_MS })
        .status ?? 1;

export const attachArgs = (distro: string): readonly string[] => ["environment", "attach", distro];

// Hands this distro to the Windows side's supervisor. False where there is no Windows agent, or one too old to take it.
export const attachToWindows = async (log: (message: string) => void): Promise<boolean> => {
    const [agent, distro] = await Promise.all([windowsRoot(), registeredDistro()]);
    if (agent === undefined || distro === undefined) {
        return false;
    }
    const attached = await runOnWindows(agent, attachArgs(distro));
    if (attached.status !== 0) {
        log(`The Windows side's agent would not take this distro over (${attached.output.split("\n")[0] ?? "no reason given"}); this distro starts its own.`);
        return false;
    }
    return true;
};
