import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "@intentic/constants";
import { writeSecretFile } from "@intentic/local-agent";
import { wslPathOf } from "@intentic/sandbox-contract";
import { baseDir, machineConfigPath } from "../config.js";
import { registeredDistro } from "../wsl.js";
import { crossEnv } from "./crossing.js";

// A PC is one version and one supervisor tree: its Windows side is the root, and every distro with an agent is its child.

const exec = promisify(execFile);

// Set by the Windows side on the agent it runs in a distro: that process has a supervisor, so it registers none.
export const SUPERVISOR_ENV = "INTENTIC_MACHINE_SUPERVISOR";
export const WINDOWS_SUPERVISOR = "windows";
export const supervisedByWindows = (env: NodeJS.ProcessEnv = process.env): boolean => env[SUPERVISOR_ENV] === WINDOWS_SUPERVISOR;

// Absent switches are on; `children` names distros by WSL registration name; `upgradeFailure` paces retries of one target.
export interface MachineConfig {
    readonly children?: readonly string[];
    readonly agentUpdates?: boolean;
    readonly sandboxUpdates?: boolean;
    readonly upgradeFailure?: { readonly target: string; readonly count: number; readonly at: number };
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
        const answer = await exec(cmd, ["/c", "echo %USERPROFILE%"], { timeout: 10_000, cwd: interopCwd() }).catch(() => undefined);
        const profile = answer?.stdout.trim();
        if (profile !== undefined && /^[A-Za-z]:\\/.test(profile)) {
            return profile;
        }
    }
    return undefined;
};

const linuxPathOf = async (windowsPath: string): Promise<string | undefined> => {
    const answer = await exec("wslpath", ["-u", windowsPath], { timeout: 5_000 }).catch(() => undefined);
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

// Runs the Windows side's agent from a distro; `vars` cross by WSLENV and `inherit` hands it this terminal.
export const runOnWindows = (
    agent: string,
    args: readonly string[],
    { vars = {}, inherit = false }: { readonly vars?: Readonly<Record<string, string>>; readonly inherit?: boolean } = {},
): { readonly status: number; readonly output: string } => {
    const result = spawnSync(agent, [...args], {
        cwd: interopCwd(),
        env: crossEnv(vars, "w"),
        encoding: "utf8",
        stdio: inherit ? "inherit" : "pipe",
        windowsHide: true,
    });
    return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

export const attachArgs = (distro: string): readonly string[] => ["environment", "attach", distro];

// Hands this distro to the Windows side's supervisor. False where there is no Windows agent, or one too old to take it.
export const attachToWindows = async (log: (message: string) => void): Promise<boolean> => {
    const [agent, distro] = await Promise.all([windowsRoot(), registeredDistro()]);
    if (agent === undefined || distro === undefined) {
        return false;
    }
    const attached = runOnWindows(agent, attachArgs(distro));
    if (attached.status !== 0) {
        log(`note: the Windows side's agent would not take this distro over (${attached.output.split("\n")[0] ?? "no reason given"}); this distro starts its own.`);
        return false;
    }
    return true;
};
