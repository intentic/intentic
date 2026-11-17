import { type FileHandle, lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { pidsOf, procFile } from "../../../seams/session-processes.js";
import { parseProcStat } from "../../../system/resources/proc-stat.js";

// A command waiting for input nobody will type, told apart from one that is merely quiet by what the kernel says it is
// doing rather than by what it printed. An agent's command runs in a tmux pane whose terminal is its stdin (bin/tmux-run),
// so a program that asks first (npx installing a package, git asking for a username, a `read -p`) waits there for good:
// on 2026-10-04 an agent sat 55 minutes on npm's "Ok to proceed? (y)", which it never saw because its own `| tail` held
// the question until an exit that never came. Text is no help here (git writes its question straight to /dev/tty, and a
// pipe hides the rest), so the question is answered from /proc instead:
// - which syscall each process of the pane's session is blocked in, and on which descriptor (/proc/<pid>/syscall): a
//   `read` on the pane's terminal is a prompt (python's input(), bash's read), and so is an event loop whose epoll set
//   holds the terminal (/proc/<pid>/fdinfo/<epfd>: node's readline, which is npm's prompt), and a poll or select whose
//   set holds it (read from /proc/<pid>/mem: python's REPL, which `python3 -` with no script opens). A socket read
//   sleeps in the same kernel wait, so the descriptor, not the wait, is what decides;
// - and whether anything moved since: CPU time, the set of processes, and the bytes the run wrote. A reader that has
//   sat still past INPUT_WAIT_MS is waiting on a person.
// A server that reads its terminal for shortcuts between requests (vite) is serving, not stuck, so a session holding a
// listening socket never reads as waiting.

/** A process of the session blocked reading the session's terminal. */
export interface TerminalReader {
    readonly pid: number;
    // Its command line on one line, cut to fit a sentence.
    readonly program: string;
}

/** What one look at a run's session found. */
export interface RunSample {
    readonly at: number;
    // User plus system time summed over every process of the session, in clock ticks.
    readonly cpuTicks: number;
    // The session's pids, sorted and joined: a process starting or ending is movement.
    readonly members: string;
    // Bytes the run has written to its capture file.
    readonly outputBytes: number;
    readonly reader: TerminalReader | undefined;
}

/** Since when nothing has moved in a run, and the latest look that says so. */
export interface RunStillness {
    readonly since: number;
    readonly sample: RunSample;
}

/** A run waiting for input: which process, and since when nothing has moved. */
export interface InputWait {
    readonly since: number;
    readonly pid: number;
    readonly program: string;
}

// How long a reader must sit still before it counts as waiting. A prompt is the one thing a process blocked on its
// terminal with no CPU and no output can be doing, so this only has to outlast a read that is answered at once.
export const INPUT_WAIT_MS = 8_000;

// Longest a program's command line runs in a sentence.
const PROGRAM_CHARS = 80;

const EVENTPOLL = "anon_inode:[eventpoll]";

// What a sample reads of one process's stat line (system/resources/proc-stat.ts parses it); undefined for an empty line
// (the process exited between the listing and the read) or one missing a field this needs.
interface StatFields {
    readonly pgrp: number;
    readonly session: number;
    // The terminal's foreground process group: only a process in it can read the terminal without being stopped.
    readonly foreground: number;
    readonly cpuTicks: number;
}

const statFields = (line: string): StatFields | undefined => {
    const parsed = line === "" ? undefined : parseProcStat(line);
    if (parsed?.session === undefined || parsed.foreground === undefined || parsed.cpuTicks === undefined) {
        return undefined;
    }
    return { pgrp: parsed.pgrp, session: parsed.session, foreground: parsed.foreground, cpuTicks: parsed.cpuTicks };
};

// What a descriptor points at, empty once the process or the descriptor is gone.
const linkOf = (path: string): Promise<string> =>
    // allow(silent-catch): a descriptor that closed, or a process that exited, between the listing and the read points at nothing.
    readlink(path).catch(() => "");

// The syscalls whose first argument is the descriptor being waited on for input, by architecture: the read family on
// the descriptor itself, and the epoll waits on a set. Others are left out on purpose: a sleep's first argument is a
// clock (CLOCK_REALTIME is 0, which reads as stdin), and a socket read's is a socket. poll's and select's are arrays in
// the process's memory, read by `blockedSet` below.
const INPUT_SYSCALLS = new Map<string, ReadonlySet<number>>([
    // read, pread64, readv, preadv, preadv2; epoll_wait, epoll_pwait, epoll_pwait2.
    ["x64", new Set([0, 17, 19, 295, 327, 232, 281, 441])],
    // read, readv, pread64, preadv, preadv2; epoll_pwait, epoll_pwait2 (arm64 has no plain epoll_wait).
    ["arm64", new Set([63, 65, 67, 69, 286, 22, 441])],
]);

/**
 * The descriptor a process is blocked waiting on for input, from its /proc/<pid>/syscall line: the first argument of a
 * read or an epoll wait. Undefined for any other syscall, a process on a CPU ("running"), or a file that could not be
 * read.
 */
export const blockedDescriptor = (syscall: string, arch: string = process.arch): number | undefined => {
    const [number, first] = syscall.trim().split(/\s+/u);
    if (number === undefined || first === undefined || !/^\d+$/u.test(number) || !/^0x[\da-f]+$/iu.test(first)) {
        return undefined;
    }
    if (INPUT_SYSCALLS.get(arch)?.has(Number(number)) !== true) {
        return undefined;
    }
    const fd = Number.parseInt(first, 16);
    return Number.isSafeInteger(fd) && fd < 1 << 20 ? fd : undefined;
};

// 2026-11-17, after the shinobi-society audit: `python3 -` with no script opens python's REPL, which waits in poll (3.13's
// REPL, a 100 ms timeout with no CPU spent between wakes) or select (readline before it), never in a read. The probe
// saw no reader, so the command sat until tmux-run's 110 s soft timeout instead of coming back as waiting for input.
// poll and ppoll: the first argument points at the pollfd array and the second counts it. select and pselect6: the first
// counts the descriptors and the second points at the read set (NULL for none).
const POLL_SYSCALLS = new Map<string, ReadonlySet<number>>([
    ["x64", new Set([7, 271])],
    ["arm64", new Set([73])],
]);
const SELECT_SYSCALLS = new Map<string, ReadonlySet<number>>([
    ["x64", new Set([23, 270])],
    ["arm64", new Set([72])],
]);

// Most descriptors a poll or select set is read for: select's own FD_SETSIZE, and far past any prompt's poll.
const MAX_SET = 1024;

/** A poll's or select's descriptor set in the blocked process's memory: where it is and how many it holds. */
export interface BlockedSet {
    readonly kind: "poll" | "select";
    readonly address: number;
    readonly count: number;
}

/** The descriptor set a process is blocked polling or selecting on, from its /proc/<pid>/syscall line. */
export const blockedSet = (syscall: string, arch: string = process.arch): BlockedSet | undefined => {
    const [number, first, second] = syscall.trim().split(/\s+/u);
    if (number === undefined || first === undefined || second === undefined || !/^\d+$/u.test(number) || ![first, second].every((arg) => /^0x[\da-f]+$/iu.test(arg))) {
        return undefined;
    }
    const call = Number(number);
    const kind = POLL_SYSCALLS.get(arch)?.has(call) === true ? "poll" : SELECT_SYSCALLS.get(arch)?.has(call) === true ? "select" : undefined;
    if (kind === undefined) {
        return undefined;
    }
    const [address, count] = (kind === "poll" ? [first, second] : [second, first]).map((arg) => Number.parseInt(arg, 16));
    return address === undefined || count === undefined || address === 0 || count === 0 || !Number.isSafeInteger(address)
        ? undefined
        : { kind, address, count: Math.min(count, MAX_SET) };
};

// poll's events that ask for input: POLLIN, POLLPRI, POLLRDNORM.
const POLL_INPUT = 0x1 | 0x2 | 0x40;

/** The descriptors a set waits on for input, from its bytes: pollfd entries ({ int fd; short events; short revents }) or a select bitmap. */
export const setDescriptors = (set: BlockedSet, bytes: Buffer): number[] => {
    if (set.kind === "poll") {
        return Array.from({ length: Math.floor(bytes.length / 8) }, (_, index) => index * 8).flatMap((at) =>
            bytes.readInt32LE(at) >= 0 && (bytes.readInt16LE(at + 4) & POLL_INPUT) !== 0 ? [bytes.readInt32LE(at)] : [],
        );
    }
    // fd_set is an array of longs, little-endian on both architectures read here: descriptor n is bit n % 8 of byte n / 8.
    return Array.from({ length: Math.min(set.count, bytes.length * 8) }, (_, fd) => fd).filter((fd) => ((bytes[fd >> 3] ?? 0) & (1 << (fd & 7))) !== 0);
};

// The set's bytes from the process's memory, empty where /proc/<pid>/mem is refused (the same ptrace access the syscall
// file needs) or the process moved on.
const setBytes = async (procRoot: string, pid: number, set: BlockedSet): Promise<Buffer> => {
    const length = set.kind === "poll" ? set.count * 8 : Math.ceil(set.count / 8);
    let file: FileHandle | undefined;
    try {
        file = await open(join(procRoot, String(pid), "mem"), "r");
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await file.read(bytes, 0, length, set.address);
        return bytes.subarray(0, bytesRead);
    } catch {
        // allow(silent-catch): a refused or vanished read leaves the probe blind for this look, never broken; empty is "not reading".
        return Buffer.alloc(0);
    } finally {
        // allow(silent-catch): closing a /proc handle whose process is gone has nothing to report.
        await file?.close().catch(() => undefined);
    }
};

// A /proc file only ptrace access may read (syscall, fdinfo), empty where it is refused: a kernel that keeps them from
// this daemon leaves the probe blind, never broken.
const guardedProcFile = (path: string): Promise<string> =>
    // allow(silent-catch): EACCES/EPERM here is the kernel's ptrace policy, and the caller reads empty as "not reading".
    procFile(path).catch(() => "");

// Whether `pid` is blocked reading `terminal`: on the terminal's own descriptor, or in an epoll set that holds it.
const readsTerminal = async (procRoot: string, pid: number, terminal: string): Promise<boolean> => {
    const syscall = await guardedProcFile(join(procRoot, String(pid), "syscall"));
    const fd = blockedDescriptor(syscall);
    if (fd === undefined) {
        const set = blockedSet(syscall);
        if (set === undefined) {
            return false;
        }
        for (const watched of setDescriptors(set, await setBytes(procRoot, pid, set))) {
            if ((await linkOf(join(procRoot, String(pid), "fd", String(watched)))) === terminal) {
                return true;
            }
        }
        return false;
    }
    const target = await linkOf(join(procRoot, String(pid), "fd", String(fd)));
    if (target === terminal) {
        return true;
    }
    if (target !== EVENTPOLL) {
        return false;
    }
    const info = await guardedProcFile(join(procRoot, String(pid), "fdinfo", String(fd)));
    for (const [, watched] of info.matchAll(/^tfd:\s+(\d+)/gmu)) {
        if (watched !== undefined && (await linkOf(join(procRoot, String(pid), "fd", watched))) === terminal) {
            return true;
        }
    }
    return false;
};

const programOf = async (procRoot: string, pid: number): Promise<string> => {
    const line = (await procFile(join(procRoot, String(pid), "cmdline"))).replaceAll("\0", " ").replaceAll(/\s+/gu, " ").trim();
    return line.length <= PROGRAM_CHARS ? line : `${line.slice(0, PROGRAM_CHARS - 1)}…`;
};

// Socket inodes the kernel lists as listening, in the network namespace `pid` sees: state 0A in /proc/net/tcp{,6}.
const listeningInodes = async (procRoot: string, pid: number): Promise<Set<string>> => {
    const inodes = new Set<string>();
    for (const table of ["tcp", "tcp6"]) {
        for (const row of (await procFile(join(procRoot, String(pid), "net", table))).split("\n").slice(1)) {
            const columns = row.trim().split(/\s+/u);
            if (columns[3] === "0A" && columns[9] !== undefined) {
                inodes.add(columns[9]);
            }
        }
    }
    return inodes;
};

// Whether any process of the session holds a listening socket: a server, whose idle read of its terminal is not a prompt.
const serves = async (procRoot: string, leader: number, members: readonly number[]): Promise<boolean> => {
    const listening = await listeningInodes(procRoot, leader);
    if (listening.size === 0) {
        return false;
    }
    for (const pid of members) {
        // allow(silent-catch): a process that exited since the listing holds no sockets.
        const fds = await readdir(join(procRoot, String(pid), "fd")).catch((): string[] => []);
        for (const fd of fds) {
            const socket = /^socket:\[(\d+)\]$/u.exec(await linkOf(join(procRoot, String(pid), "fd", fd)));
            if (socket?.[1] !== undefined && listening.has(socket[1])) {
                return true;
            }
        }
    }
    return false;
};

// lstat: for a fenced turn the capture file sits in the turn's own temp dir, where a link there must not report the size
// of whatever it names.
const outputSize = (path: string): Promise<number> =>
    lstat(path).then(
        (info) => info.size,
        // allow(silent-catch): no capture file yet is no output yet.
        () => 0,
    );

/** A run to look at: the session its pane's runner leads, and the file its output is captured in. */
export interface RunToSample {
    readonly leader: number;
    readonly outputPath: string;
}

// Every process on the machine, read once and grouped by the session it belongs to.
const sessions = async (procRoot: string): Promise<Map<number, { pid: number; fields: StatFields }[]>> => {
    const bySession = new Map<number, { pid: number; fields: StatFields }[]>();
    for (const pid of await pidsOf(procRoot)) {
        const fields = statFields(await procFile(join(procRoot, String(pid), "stat")));
        if (fields !== undefined) {
            bySession.set(fields.session, [...(bySession.get(fields.session) ?? []), { pid, fields }]);
        }
    }
    return bySession;
};

const sampleOne = async (
    procRoot: string,
    run: RunToSample,
    processes: readonly { pid: number; fields: StatFields }[],
    at: number,
): Promise<RunSample | undefined> => {
    if (!processes.some(({ pid }) => pid === run.leader)) {
        return undefined;
    }
    // The pane's terminal is the runner's stdin; a run with none (a tmux-less fallback) has no terminal to wait on.
    const tty = await linkOf(join(procRoot, String(run.leader), "fd", "0"));
    const terminal = tty.startsWith("/dev/pts/") || tty.startsWith("/dev/tty") ? tty : undefined;
    const members = processes.map(({ pid }) => pid).toSorted((left, right) => left - right);
    let reader: TerminalReader | undefined;
    if (terminal !== undefined) {
        for (const { pid } of processes.filter(({ fields }) => fields.pgrp === fields.foreground)) {
            if (await readsTerminal(procRoot, pid, terminal)) {
                reader = { pid, program: await programOf(procRoot, pid) };
                break;
            }
        }
        if (reader !== undefined && (await serves(procRoot, run.leader, members))) {
            reader = undefined;
        }
    }
    return {
        at,
        cpuTicks: processes.reduce((sum, { fields }) => sum + fields.cpuTicks, 0),
        members: members.join(" "),
        outputBytes: await outputSize(run.outputPath),
        reader,
    };
};

/**
 * One look at each run's session (the pane's runner and everything it started): its CPU, its processes, its output,
 * and the process blocked reading the pane's terminal, if one is. A run whose leader is gone has no sample. One pass
 * over /proc serves every run, so a look costs the same whether one command is running or twenty.
 */
export const sampleRuns = async <Key>(runs: ReadonlyMap<Key, RunToSample>, procRoot = "/proc", at: number = Date.now()): Promise<Map<Key, RunSample>> => {
    const samples = new Map<Key, RunSample>();
    if (runs.size === 0) {
        return samples;
    }
    const bySession = await sessions(procRoot);
    for (const [key, run] of runs) {
        const sample = await sampleOne(procRoot, run, bySession.get(run.leader) ?? [], at);
        if (sample !== undefined) {
            samples.set(key, sample);
        }
    }
    return samples;
};

const unmoved = (before: RunSample, after: RunSample): boolean =>
    before.cpuTicks === after.cpuTicks && before.members === after.members && before.outputBytes === after.outputBytes && before.reader?.pid === after.reader?.pid;

/** The stillness after one more look: carried on when nothing moved, restarted from this look when anything did. */
export const stillnessAfter = (before: RunStillness | undefined, sample: RunSample): RunStillness =>
    before !== undefined && unmoved(before.sample, sample) ? { since: before.since, sample } : { since: sample.at, sample };

/** Whether a run is waiting for input: a reader of its terminal, and nothing moved for INPUT_WAIT_MS. */
export const inputWaitOf = (stillness: RunStillness): InputWait | undefined => {
    const reader = stillness.sample.reader;
    return reader === undefined || stillness.sample.at - stillness.since < INPUT_WAIT_MS ? undefined : { since: stillness.since, pid: reader.pid, program: reader.program };
};
