import { execFile, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { claimPidFile, type Log, releasePidFile } from "@intentic/local-agent";
import { DEV_VERSION, isNewer } from "@intentic/sandbox-contract";
import { binDir, upgradeLockPath } from "../config.js";
import { installedBuild } from "../installed.js";
import { publishedVersion } from "../release.js";
import { readResident, restartResident } from "../supervision.js";
import { realUpgradeExec, runUpgrade, type UpgradeOutcome, upgradeLanded, upgradeMessage } from "../upgrade.js";
import { MACHINE_VERSION } from "../version.js";
import { agentInDistro, crossEnv, NO_AGENT_EXIT } from "./crossing.js";
import { childrenOf, readMachineConfig, runOnWindows, updateMachineConfig, windowsRoot } from "./machine.js";

// A PC upgrades as one: whichever side is asked, every environment ends on the same exact release or says why it did not.

const exec = promisify(execFile);

// Set on one leg of a machine-wide upgrade (and on setup's re-exec): this environment only, to exactly this release.
export const UPGRADE_ENV = "INTENTIC_MACHINE_UPGRADE";

// The newest release this machine or the channel has; never a from-source build, which no release can be compared to.
export const machineTarget = (published: string | undefined, installed: readonly (string | undefined)[]): string | undefined =>
    [published, ...installed]
        .filter((version): version is string => version !== undefined && version !== DEV_VERSION)
        .reduce<string | undefined>((best, version) => (best === undefined || isNewer(version, best) ? version : best), undefined);

// An upgrade holds this environment for its whole length; a second one waits rather than splicing into its download.
const LOCK_WAIT_MS = 15 * 60_000;
const LOCK_POLL_MS = 2_000;

const withUpgradeLock = async (log: Log, run: () => Promise<UpgradeOutcome>): Promise<UpgradeOutcome> => {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let said = false;
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded wait on one lock, serial by definition
        const claim = await claimPidFile(upgradeLockPath, binDir, { pid: process.pid });
        if (claim.claimed) {
            break;
        }
        if (Date.now() > deadline) {
            return { kind: "failed", reason: `another upgrade (pid ${claim.holder.pid}) is still running here.` };
        }
        if (!said) {
            said = true;
            log(`Waiting for the upgrade already running here (pid ${claim.holder.pid})…`);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await sleep(LOCK_POLL_MS);
    }
    try {
        return await run();
    } finally {
        await releasePidFile(upgradeLockPath, process.pid);
    }
};

// This environment alone, to `target`: what one leg of a machine-wide upgrade and setup's self-update both run.
export const upgradeHere = async (target: string, force: boolean, log: Log): Promise<UpgradeOutcome> =>
    await withUpgradeLock(log, async () => {
        const running = async (): Promise<string | undefined> => (await readResident())?.build;
        const restart = async (): Promise<string | undefined> => {
            await restartResident(() => undefined);
            return await running();
        };
        return await runUpgrade(realUpgradeExec(restart, running, log), target, installedBuild() ?? MACHINE_VERSION, force, log);
    });

// A distro's installed agent, asked in that distro; undefined where none answers, which is not a version to compare.
export const installedIn = async (distro: string): Promise<string | undefined> => {
    const { command, args } = agentInDistro(distro, ["version"]);
    const answer = await exec(command, [...args], { timeout: 60_000, windowsHide: true }).catch(() => undefined);
    return /^\d+\.\d+\.\d+$/.exec(answer?.stdout.trim() ?? "")?.[0];
};

// One leg, streamed under its distro's name. True when that distro's agent ends on `target`.
const upgradeIn = async (distro: string, target: string, force: boolean, log: Log): Promise<boolean> =>
    await new Promise((resolve) => {
        const { command, args } = agentInDistro(distro, ["upgrade", ...(force ? ["--force"] : [])]);
        const child = spawn(command, [...args], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: crossEnv({ [UPGRADE_ENV]: target }, "u"),
        });
        const relay = (chunk: Buffer): void => {
            for (const line of chunk
                .toString("utf8")
                .split(/\r?\n/)
                .filter((one) => one.trim() !== "")) {
                log(`  [${distro}] ${line}`);
            }
        };
        child.stdout.on("data", relay);
        child.stderr.on("data", relay);
        child.once("error", (error) => {
            log(`  [${distro}] could not be reached through wsl.exe (${error.message}).`);
            resolve(false);
        });
        child.once("close", (code) => {
            if (code === NO_AGENT_EXIT) {
                log(`  [${distro}] has no agent installed any more; nothing to upgrade there.`);
            }
            resolve(code === 0 || code === NO_AGENT_EXIT);
        });
    });

// Everything a machine-wide upgrade touches outside this function, so the order is a rule with a test.
export interface MachineIo {
    readonly leg: string | undefined;
    readonly windowsRoot: () => Promise<string | undefined>;
    readonly delegate: (agent: string, args: readonly string[]) => number;
    readonly children: () => Promise<readonly string[]>;
    readonly published: () => Promise<string | undefined>;
    readonly installedHere: () => string | undefined;
    readonly installedIn: (distro: string) => Promise<string | undefined>;
    readonly upgradeIn: (distro: string, target: string) => Promise<boolean>;
    readonly upgradeHere: (target: string) => Promise<UpgradeOutcome>;
    readonly recorded: (failedTarget: string | undefined) => Promise<void>;
}

// `level` moves the machine only as far as its own newest side, never to a release none of it runs yet.
export interface MachineUpgradeAsk {
    readonly force: boolean;
    readonly level: boolean;
}

const askArgs = (ask: MachineUpgradeAsk): readonly string[] => [...(ask.force ? ["--force"] : []), ...(ask.level ? ["--level"] : [])];

// The children first, the side that was asked last: its own restart is what ends a stream a sandbox is reading.
const upgradeFromRoot = async (io: MachineIo, ask: MachineUpgradeAsk, log: Log): Promise<boolean> => {
    const children = await io.children();
    const [published, ...theirs] = await Promise.all([ask.level ? Promise.resolve(undefined) : io.published(), ...children.map(io.installedIn)]);
    const target = machineTarget(published, [io.installedHere(), ...theirs]);
    // Levelling never asks the channel, so no target there is a machine with no released side, which is nothing to do.
    if (target === undefined) {
        log(
            ask.level
                ? "Nothing to level: no side of this machine runs a released agent."
                : "Upgrade didn't happen: couldn't reach the release channel, nothing was changed.",
        );
        return ask.level;
    }
    if (children.length > 0) {
        log(`Bringing this PC to ${target}: ${[...children, "this side"].join(", ")}.`);
    }
    const legs: boolean[] = [];
    for (const child of children) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one environment at a time; each restarts what it upgrades
        legs.push(await io.upgradeIn(child, target));
    }
    const here = await io.upgradeHere(target);
    log(upgradeMessage(here));
    const landed = legs.every(Boolean) && upgradeLanded(here);
    await io.recorded(landed ? undefined : target);
    return landed;
};

// A leg upgrades only itself; a distro hands the whole job to its Windows side; anything else is the root and does it.
export const upgradeMachine = async (io: MachineIo, ask: MachineUpgradeAsk, log: Log): Promise<boolean> => {
    if (io.leg !== undefined) {
        const outcome = await io.upgradeHere(io.leg);
        log(upgradeMessage(outcome));
        return upgradeLanded(outcome);
    }
    const root = await io.windowsRoot();
    if (root !== undefined) {
        log("This is a WSL distro: the whole PC is upgraded from its Windows side.");
        return io.delegate(root, ["upgrade", ...askArgs(ask)]) === 0;
    }
    return await upgradeFromRoot(io, ask, log);
};

// A failed target is remembered so the automatic tick backs off from it instead of downloading it every pass.
const recordFailure = async (failedTarget: string | undefined): Promise<void> => {
    await updateMachineConfig((config) => {
        const { upgradeFailure: previous, ...rest } = config;
        if (failedTarget === undefined) {
            return rest;
        }
        const count = previous?.target === failedTarget ? previous.count + 1 : 1;
        return { ...rest, upgradeFailure: { target: failedTarget, count, at: Date.now() } };
    });
};

export const realMachineIo = (ask: MachineUpgradeAsk, log: Log): MachineIo => ({
    leg: process.env[UPGRADE_ENV],
    windowsRoot,
    delegate: (agent, args) => runOnWindows(agent, args, { inherit: true }).status,
    children: async () => (process.platform === "win32" ? childrenOf(await readMachineConfig()) : []),
    published: publishedVersion,
    installedHere: installedBuild,
    installedIn,
    upgradeIn: async (distro, target) => await upgradeIn(distro, target, ask.force, log),
    upgradeHere: async (target) => await upgradeHere(target, ask.force, log),
    recorded: recordFailure,
});

// The versions of every other side this one can reach: a distro sees its Windows side, the Windows side its distros.
export const siblingVersions = async (): Promise<readonly (string | undefined)[]> => {
    const root = await windowsRoot();
    if (root !== undefined) {
        const answer = runOnWindows(root, ["version"]);
        return [answer.status === 0 ? /^\d+\.\d+\.\d+$/.exec(answer.output)?.[0] : undefined];
    }
    return process.platform === "win32" ? await Promise.all(childrenOf(await readMachineConfig()).map(installedIn)) : [];
};
