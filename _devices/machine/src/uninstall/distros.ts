import { errorMessage } from "@intentic/base/errors";
import { runBounded } from "@intentic/base/process";
import { agentInDistro, crossEnv } from "../environments/crossing.js";
import { childrenOf, type MachineConfig, readMachineConfig, updateMachineConfig } from "../environments/machine.js";
import { distroOutcome } from "./plan.js";
import type { Tally } from "./tally.js";

/* THE WSL DISTROS THIS PC'S WINDOWS SIDE KEEPS RUNNING, PURGED FROM HERE (`uninstall --purge` on Windows). Each distro
   in machine.json has an agent of its own, which the Windows side starts and restarts; a purge of the Windows side alone
   left every one of them installed, and the Windows side's own agent running "to keep this device's WSL distros
   running". Each distro's agent is asked to purge itself, through wsl.exe and bounded, and then the distros leave
   machine.json, so nothing on this PC supervises them any more. A distro's agent that does not answer is said with the
   command that finishes it there, and leaves the list all the same: its supervisor is what is being removed. */

// A distro's purge stops its agent, its keyring and its Mutagen and deletes its files; minutes at the very most.
const DISTRO_PURGE_TIMEOUT_MS = 5 * 60_000;

const byHand = (distro: string, deleteData: boolean): string =>
    `wsl -d ${distro} -- ~/.intentic/machine/bin/intentic-machine uninstall --purge${deleteData ? " --delete-data" : ""}`;

// Its plain stdout, as narration under this run's own: the `intentic: ` prefix gives way to the distro's name.
const relayNotes = (distro: string, stdout: string, say: Tally): void => {
    for (const line of stdout.split(/\r?\n/u)) {
        const text = line.replace(/^intentic: /u, "").trim();
        if (text !== "") {
            say.note(`${distro}: ${text}`);
        }
    }
};

// Its stderr, block by block (a line with the prefix starts one, an indented `fix:` continues it): a warning stays a
// warning here, fix and all, so the verdict counts it; its stop, if it ended in one, is narrated, and said as this
// run's own warning by the caller.
export interface StderrBlocks {
    readonly warnings: readonly string[];
    readonly stop: readonly string[];
}

export const stderrBlocks = (stderr: string): StderrBlocks => {
    const warnings: string[] = [];
    const stop: string[] = [];
    let into: string[] | undefined;
    for (const line of stderr.split(/\r?\n/u)) {
        if (line.startsWith("intentic: ")) {
            warnings.push(line.slice("intentic: ".length));
            into = warnings;
        } else if (line.startsWith("error: ")) {
            stop.push(line.slice("error: ".length));
            into = stop;
        } else if (line.trim() !== "" && into !== undefined && into.length > 0) {
            into[into.length - 1] = `${into.at(-1) ?? ""}\n   ${line.trim()}`;
        }
    }
    return { warnings, stop };
};

const relay = (distro: string, output: { readonly stdout: string; readonly stderr: string }, say: Tally): void => {
    relayNotes(distro, output.stdout, say);
    const { warnings, stop } = stderrBlocks(output.stderr);
    for (const warning of warnings) {
        say.warn(`${distro}: ${warning}`);
    }
    for (const block of stop) {
        say.note(`${distro}: ${block}`);
    }
};

const runInDistro = async (
    distro: string,
    args: readonly string[],
): Promise<{ readonly code: number | null; readonly output: { readonly stdout: string; readonly stderr: string } }> => {
    const { command, args: argv } = agentInDistro(distro, args);
    const result = await runBounded(command, argv, { timeoutMs: DISTRO_PURGE_TIMEOUT_MS, env: crossEnv({ INTENTIC_UI: "plain" }, "u") });
    if (result.spawnError !== undefined) {
        throw result.spawnError;
    }
    return { code: result.timedOut ? null : result.exitCode, output: { stdout: result.stdout.text, stderr: result.stderr.text } };
};

const purgeOne = async (distro: string, deleteData: boolean, say: Tally): Promise<void> => {
    const flags = ["uninstall", "--purge", ...(deleteData ? ["--delete-data"] : [])];
    const { code, output } = await runInDistro(distro, flags);
    relay(distro, output, say);
    const outcome = distroOutcome(code);
    if (outcome === "purged") {
        say.note(`Removed the agent from the ${distro} distro.`);
        return;
    }
    if (outcome === "no-agent") {
        say.note(`The ${distro} distro has no agent installed any more.`);
        return;
    }
    if (outcome === "older") {
        // An agent from before --purge still takes the plain uninstall: its links, pairings and login entry go.
        const plain = await runInDistro(distro, ["uninstall"]);
        relay(distro, plain.output, say);
        say.warn(
            `The ${distro} distro's agent is older than this one and cannot purge itself: its links and pairings went, its files stay there.`,
            `wsl -d ${distro} -- sh -c '~/.intentic/machine/bin/intentic-machine upgrade && ~/.intentic/machine/bin/intentic-machine uninstall --purge${deleteData ? " --delete-data" : ""}'`,
        );
        return;
    }
    say.warn(
        code === null
            ? `The ${distro} distro's agent did not finish removing itself within ${DISTRO_PURGE_TIMEOUT_MS / 60_000} minutes.`
            : `The ${distro} distro's agent did not remove itself (exit ${code}).`,
        byHand(distro, deleteData),
    );
};

const withoutChildren = (config: MachineConfig): MachineConfig => {
    const { children: _gone, ...rest } = config;
    return rest;
};

/** Purges every distro this Windows side supervises, then lets go of them all. Never throws: each failure is said. */
export const purgeDistros = async (deleteData: boolean, say: Tally): Promise<void> => {
    let distros: readonly string[];
    try {
        distros = childrenOf(await readMachineConfig());
    } catch (error) {
        say.warn(`This device's list of WSL distros could not be read (${errorMessage(error)}), so no distro's agent was removed from here.`, "wsl -d <distro> -- ~/.intentic/machine/bin/intentic-machine uninstall --purge");
        return;
    }
    for (const distro of distros) {
        // one distro at a time: each speaks through this run's narration, and wsl.exe boots them one by one anyway
        await purgeOne(distro, deleteData, say).catch((error: Error) =>
            say.warn(`The ${distro} distro could not be reached through wsl.exe (${errorMessage(error)}).`, byHand(distro, deleteData)),
        );
    }
    if (distros.length === 0) {
        return;
    }
    try {
        await updateMachineConfig(withoutChildren);
        say.note(`Nothing on this device keeps ${distros.length === 1 ? "that distro's agent" : "those distros' agents"} running any more.`);
    } catch (error) {
        // The agent's own retirement below does not depend on this list: it is stopped and its entry removed regardless.
        say.warn(`This device's list of WSL distros could not be emptied (${errorMessage(error)}); it goes with the agent's folder.`);
    }
};
