import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { plural } from "@intentic/base/format";
import type { Log } from "@intentic/local-agent";
import { z } from "zod";
import { baseDir } from "../../config.js";

// COMMANDS A DEAD AGENT LEFT RUNNING. run_command's children get a process group of their own (shell.ts), and the
// agent's systemd unit stops only the agent's own process (KillMode=process, local-agent's autostart.ts), so that an ic
// mid-swap and Mutagen's daemon outlive a restart. A command still running when the agent CRASHES would outlive it too,
// with nobody left to enforce its deadline or read its answer. So each group is written down while it runs, a stopping
// agent ends its own (shell.ts), and the next agent to start ends the groups a dead one left. Linux only: /proc is what
// tells a live group from a number since given to somebody else, and systemd is the supervisor that changed.

const ledgerPath = join(baseDir, "commands.running");

// One group: its id (the pid of the shell that leads it) and that shell's start time, which a reused pid does not share.
const GroupSchema = z.object({ pgid: z.number(), started: z.string() });
const LedgerSchema = z.object({ boot: z.string(), groups: z.array(GroupSchema) });
type Group = z.infer<typeof GroupSchema>;

// /proc/<pid>/stat's 22nd field, the start time in clock ticks since boot. Read after the command name's closing
// parenthesis, since the name itself may hold spaces and parentheses.
export const startTimeOf = (stat: string): string | undefined => {
    const close = stat.lastIndexOf(")");
    return close < 0 ? undefined : stat.slice(close + 2).split(" ")[19];
};

// Whether a recorded group is still the one a dead agent left: its leader alive with the start time recorded, or its
// leader gone and something still answering to the group, which the kernel never hands out again while it does.
export const stillLeftOver = (group: Group, leaderStarted: string | undefined, groupAnswers: boolean): boolean =>
    leaderStarted === undefined ? groupAnswers : leaderStarted === group.started;

const LINUX = process.platform === "linux";

// allow(silent-catch): a kernel without the file has no boot to tell apart, and nothing is recorded
const bootId = async (): Promise<string> => (await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "")).trim();

// allow(silent-catch): no such process is the answer this asks for
const leaderStart = async (pid: number): Promise<string | undefined> => startTimeOf(await readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""));

const groupAnswers = (pgid: number): boolean => {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (error) {
        // SAFETY: process.kill throws only system errors, which carry their errno code.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

// The groups running now, as the file says, and the writes that keep it so, one after another. Kept only by the
// resident agent, from the moment it takes the ledger over (below): a one-shot command or a test running commands is
// not the process a crash would orphan them from, and must not write over the agent's file.
const running = new Map<number, string>();
let kept = false;
let boot: Promise<string> | undefined;
let writes: Promise<void> = Promise.resolve();

const save = (): Promise<void> => {
    writes = writes.then(async () => {
        const groups = [...running].map(([pgid, started]) => ({ pgid, started }));
        await writeFileAtomic(ledgerPath, JSON.stringify({ boot: await (boot ??= bootId()), groups }));
    });
    // allow(silent-catch): a ledger that did not land costs only the cleanup after a crash, never the command
    writes = writes.catch(() => undefined);
    return writes;
};

// A command's group, written down for as long as it runs.
export const recordCommand = async (pid: number): Promise<void> => {
    const started = LINUX && kept ? await leaderStart(pid) : undefined;
    if (started !== undefined) {
        running.set(pid, started);
        await save();
    }
};

export const forgetCommand = async (pid: number): Promise<void> => {
    if (running.delete(pid)) {
        await save();
    }
};

// The resident agent's, at its start, before it runs anything of its own: every group the file names from this boot
// that is still what a dead agent left is ended, the file starts over, and from here on this process keeps it.
export const takeOverCommandLedger = async (log: Log): Promise<void> => {
    if (!LINUX) {
        return;
    }
    kept = true;
    // allow(silent-catch): no file is nothing left over
    const raw = await readFile(ledgerPath, "utf8").catch(() => undefined);
    let ledger: z.infer<typeof LedgerSchema> | undefined;
    try {
        const parsed = raw === undefined ? undefined : LedgerSchema.safeParse(JSON.parse(raw));
        ledger = parsed?.success === true ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a torn file names nothing reliably, and killing on a guess is worse than leaving it
        ledger = undefined;
    }
    const current = await (boot ??= bootId());
    const left = ledger === undefined || ledger.boot !== current ? [] : ledger.groups;
    let ended = 0;
    for (const group of left) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of groups, each one /proc read
        if (stillLeftOver(group, await leaderStart(group.pgid), groupAnswers(group.pgid))) {
            try {
                process.kill(-group.pgid, "SIGKILL");
                ended += 1;
            } catch (error) {
                log(`could not end a command the last agent left running (group ${group.pgid}): ${errorMessage(error)}`);
            }
        }
    }
    if (ended > 0) {
        log(`ended ${plural(ended, "command")} the last agent was running when it stopped without ending them.`);
    }
    await save();
};
