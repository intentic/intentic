// The record a long-lived dev preview leaves while it runs, so the sandbox can keep their number down. The demo's dev
// script starts one per conversation and writes its record (_site/demo/scripts/dev.mjs); the server itself refreshes
// the record while it is used and stops itself once it is not (_site/demo/vite.config.ts, previewKeeper); the daemon
// shields a recorded server from the sweep that ends a finished turn's processes, and stops one that outlived its own
// idle stop (_sandbox/sandbox/src/processes/dev-previews.ts); the `preview` command lists and stops them
// (_sandbox/sandbox/bin/preview). Plain JavaScript with no dependencies, so all of them read one definition of where
// the records live, what makes one trustworthy, and how a preview is stopped.
//
// A record names a process, and the keepers signal it, so a record alone proves nothing: the process must still be
// alive, must have started at the clock tick the record says (a reused pid fails that), and must carry the
// conversation stamp (INTENTIC_TURN_OWNER) the record claims. A record written from another pid namespace (an agent
// domain has its own) names a pid this reader cannot see, so it is neither trusted nor removed here.
import { chmodSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const PREVIEWS_DIR_ENV = "INTENTIC_PREVIEWS_DIR";
// /tmp, not the workspace: every conversation's mount namespace and the daemon see the same /tmp (the background
// jobs' run directories live there for the same reason), and nothing here should ever ride a land.
export const DEFAULT_PREVIEWS_DIR = "/tmp/intentic-previews";
export const OWNER_ENV = "INTENTIC_TURN_OWNER";
// Set on a server the dev script started, naming its record, so the server can keep it current.
export const RECORD_ENV = "INTENTIC_PREVIEW_RECORD";
// Ports the previews pick from: clear of 47145 and 47146, which the editor mirrors from the owner's own machine (a
// server there may be serving the owner's tree, not the conversation's).
export const PREVIEW_PORTS = Object.freeze({ first: 47150, last: 47199 });
// How many previews run at once across the sandbox, and how long one may go unused before it stops. One demo server
// holds 0.8 GiB warm and 2 GiB while it optimizes (measured 2026-10-27); five to seven of them, each up for a whole turn
// and idle most of it, were 9-13 GiB of a 21 GiB sandbox on 2026-10-26.
export const PREVIEW_CAP = 3;
export const PREVIEW_IDLE_MS = 10 * 60_000;
// How often a running server refreshes its record's lastActiveAt while it is used.
export const TOUCH_EVERY_MS = 30_000;
// How long a signalled preview gets to exit before SIGKILL.
const TERM_GRACE_MS = 5_000;
const RECORD_SUFFIX = ".json";
const STOP_SUFFIX = ".stop";
const ENDED_SUFFIX = ".ended";

export const previewsDir = (env = process.env) => env[PREVIEWS_DIR_ENV] || DEFAULT_PREVIEWS_DIR;

// One record per conversation and label: a second start in the same conversation finds the first.
export const recordName = (conversation, label) => `${conversation}--${label}`.replaceAll(/[^A-Za-z0-9._-]/gu, "_");
export const recordPath = (dir, conversation, label) => join(dir, `${recordName(conversation, label)}${RECORD_SUFFIX}`);
const stopPath = (dir, conversation, label) => join(dir, `${recordName(conversation, label)}${STOP_SUFFIX}`);
const endedPath = (dir, conversation, label) => join(dir, `${recordName(conversation, label)}${ENDED_SUFFIX}`);

// A restart replaces the old directory entry, then creates exclusively: a pre-planted symlink or hard link never
// opens its target for truncation. A concurrent creator makes the open fail instead of following its entry.
export const openPreviewLog = (dir, conversation, label) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${recordName(conversation, label)}.log`);
    rmSync(path, { force: true });
    return { path, fd: openSync(path, "wx") };
};

// A conversation id as one DNS label, for its preview's hostname: `<label>.demo.localhost`.
export const hostLabel = (conversation) => {
    const label = conversation
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/gu, "-")
        .replace(/^-+/u, "");
    let end = label.length;
    while (label.charAt(end - 1) === "-") {
        end -= 1;
    }
    return label.slice(0, Math.min(end, 63)) || "preview";
};

// Field 22 of /proc/<pid>/stat, the process's start time in clock ticks since boot. The command name (field 2) can
// hold spaces and parentheses, so fields are counted after its closing parenthesis.
export const startTicksOf = (pid, procRoot = "/proc") => {
    try {
        const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } catch {
        // allow(silent-catch): no such process (or no /proc) is the answer "not running".
        return undefined;
    }
};

// The conversation stamp a process started with, from its initial environment.
export const ownerOf = (pid, procRoot = "/proc") => {
    try {
        const environ = readFileSync(join(procRoot, String(pid), "environ"), "utf8");
        const entry = environ.split("\0").find((line) => line.startsWith(`${OWNER_ENV}=`));
        return entry === undefined ? undefined : entry.slice(OWNER_ENV.length + 1);
    } catch {
        // allow(silent-catch): unreadable means unowned, and an unowned process is never one a record may name.
        return undefined;
    }
};

// Which pid namespace a process (default: this one) is in, as the kernel names it (`pid:[4026532293]`).
export const pidNamespaceOf = (pid = "self", procRoot = "/proc") => {
    try {
        return readlinkSync(join(procRoot, String(pid), "ns", "pid"));
    } catch {
        // allow(silent-catch): no procfs is one namespace nobody can tell apart, named as such.
        return "";
    }
};

// A preview's address is loopback: the IP itself, or a name under `.localhost`, which browsers resolve there.
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost):\d+\//u;

const isPort = (port) => Number.isSafeInteger(port) && port > 0 && port < 65_536;
// What each field of a record must be once coerced.
const RECORD_RULES = [
    (record) => record.v === 1 && record.conversation !== "" && record.label !== "",
    (record) => Number.isSafeInteger(record.pid) && record.pid > 1 && /^\d+$/u.test(record.startTicks),
    (record) => isPort(record.port) && LOOPBACK_URL.test(record.url),
    (record) => Number.isFinite(record.startedAt) && Number.isFinite(record.lastActiveAt),
];

// A record as read off disk, or undefined for anything that is not one: every field coerced to its type, then held to
// what it means (a positive pid, digits for the start tick, a port in range, a loopback URL).
export const parseRecord = (text) => {
    let raw;
    try {
        raw = JSON.parse(text) ?? {};
    } catch {
        // allow(silent-catch): a half-written or foreign file is not a record.
        return undefined;
    }
    const record = {
        v: Number(raw.v),
        conversation: String(raw.conversation ?? ""),
        label: String(raw.label ?? ""),
        pid: Number(raw.pid),
        startTicks: String(raw.startTicks ?? ""),
        pidNamespace: String(raw.pidNamespace ?? ""),
        port: Number(raw.port),
        url: String(raw.url ?? ""),
        root: String(raw.root ?? ""),
        log: String(raw.log ?? ""),
        startedAt: Number(raw.startedAt),
        lastActiveAt: Number(raw.lastActiveAt ?? raw.startedAt),
    };
    return RECORD_RULES.every((holds) => holds(record)) ? record : undefined;
};

// Whether a record was written from this reader's pid namespace, so its pid means the process it meant.
export const recordIsOurs = (record, procRoot = "/proc") => record.pidNamespace === pidNamespaceOf("self", procRoot);

// Whether the process a record names is the one that wrote it, still running.
export const recordIsLive = (record, procRoot = "/proc") =>
    startTicksOf(record.pid, procRoot) === record.startTicks && ownerOf(record.pid, procRoot) === record.conversation;

// Written whole and renamed into place, so a reader never sees half a file.
const writeWhole = (path, text) => {
    const staging = mkdtempSync(`${path}.`);
    try {
        const temporary = join(staging, "record");
        writeFileSync(temporary, text, { flag: "wx" });
        renameSync(temporary, path);
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
};

// A dead record's stop note becomes its ended note: why it stopped, kept for the next start or listing to say.
const retire = (dir, record) => {
    const reason = stopReason(dir, record);
    if (reason !== undefined) {
        writeWhole(endedPath(dir, record.conversation, record.label), `${JSON.stringify({ reason, at: Date.now() })}\n`);
    }
    removeRecord(dir, record);
};

// Every live record in the directory written from this pid namespace; a file that does not parse is removed, and so is
// one of ours naming a process that is gone or not its own (its stop note kept as the ended note).
export const readRecords = (dir = previewsDir(), procRoot = "/proc") => {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        // allow(silent-catch): no directory yet is no previews.
        return [];
    }
    const namespace = pidNamespaceOf("self", procRoot);
    const records = [];
    for (const name of names.filter((one) => one.endsWith(RECORD_SUFFIX))) {
        const path = join(dir, name);
        let record;
        try {
            record = parseRecord(readFileSync(path, "utf8"));
        } catch {
            // allow(silent-catch): a file removed between the listing and the read is gone either way.
            continue;
        }
        if (record === undefined) {
            rmSync(path, { force: true });
        } else if (record.pidNamespace !== namespace) {
            continue;
        } else if (recordIsLive(record, procRoot)) {
            records.push(record);
        } else {
            retire(dir, record);
        }
    }
    return records.toSorted((a, b) => a.startedAt - b.startedAt);
};

export const writeRecord = (dir, record) => {
    mkdirSync(dir, { recursive: true });
    // Sticky and open to all, like /tmp: a conversation in an agent domain writes here as a different uid.
    try {
        chmodSync(dir, 0o1777);
    } catch {
        // allow(silent-catch): a directory someone else made is theirs to keep open; writing below still says if it is not.
    }
    const path = recordPath(dir, record.conversation, record.label);
    writeWhole(path, `${JSON.stringify(record)}\n`);
    rmSync(stopPath(dir, record.conversation, record.label), { force: true });
    rmSync(endedPath(dir, record.conversation, record.label), { force: true });
    return path;
};

// The record with a later lastActiveAt, written in place; a record removed meanwhile (the preview was stopped) stays
// removed.
export const touchRecord = (path, at = Date.now()) => {
    let record;
    try {
        record = parseRecord(readFileSync(path, "utf8"));
    } catch {
        // allow(silent-catch): no record is nothing to touch.
        return undefined;
    }
    if (record === undefined) {
        return undefined;
    }
    const touched = { ...record, lastActiveAt: Math.max(record.lastActiveAt, at) };
    writeWhole(path, `${JSON.stringify(touched)}\n`);
    return touched;
};

export const removeRecord = (dir, record) => {
    rmSync(recordPath(dir, record.conversation, record.label), { force: true });
    rmSync(stopPath(dir, record.conversation, record.label), { force: true });
};

// Why the sandbox is stopping a preview, written before the signal, so whoever looks next can say why it stopped.
export const noteStop = (dir, record, reason) => {
    writeWhole(stopPath(dir, record.conversation, record.label), `${reason}\n`);
};

export const stopReason = (dir, record) => {
    try {
        return readFileSync(stopPath(dir, record.conversation, record.label), "utf8").trim() || undefined;
    } catch {
        // allow(silent-catch): no note means nobody but the preview's own caller stopped it.
        return undefined;
    }
};

// Why this conversation's last preview of `label` stopped, when the sandbox stopped it: { reason, at }.
export const endedNote = (dir, conversation, label) => {
    try {
        const note = JSON.parse(readFileSync(endedPath(dir, conversation, label), "utf8")) ?? {};
        const ended = { reason: String(note.reason ?? ""), at: Number(note.at) };
        return ended.reason !== "" && Number.isFinite(ended.at) ? ended : undefined;
    } catch {
        // allow(silent-catch): no note is a preview nobody stopped, or one already reported.
        return undefined;
    }
};

export const clearEnded = (dir, conversation, label) => rmSync(endedPath(dir, conversation, label), { force: true });

// Which previews to stop so that one more fits under `cap`: the least recently used first.
export const overCap = (records, cap = PREVIEW_CAP) =>
    records.toSorted((a, b) => a.lastActiveAt - b.lastActiveAt).slice(0, Math.max(0, records.length - cap + 1));

// Which previews have gone unused past the idle bound, judged by their record alone.
export const idleRecords = (records, now = Date.now(), idleMs = PREVIEW_IDLE_MS) => records.filter((record) => now - record.lastActiveAt >= idleMs);

const signalGroup = (pid, signal) => {
    try {
        process.kill(-pid, signal);
        return true;
    } catch {
        try {
            process.kill(pid, signal);
            return true;
        } catch {
            // allow(silent-catch): already gone, which is what stopping it was for.
            return false;
        }
    }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stops a preview: the reason noted first, then SIGTERM to its process group (a preview leads its own), SIGKILL once
// the grace is up, and its record retired so the reason is what remains. Resolves once it has exited.
export const stopPreview = async (dir, record, reason, { graceMs = TERM_GRACE_MS, procRoot = "/proc" } = {}) => {
    noteStop(dir, record, reason);
    if (signalGroup(record.pid, "SIGTERM")) {
        const deadline = Date.now() + graceMs;
        while (recordIsLive(record, procRoot) && Date.now() < deadline) {
            await delay(100);
        }
        if (recordIsLive(record, procRoot)) {
            signalGroup(record.pid, "SIGKILL");
        }
    }
    retire(dir, record);
};

// Whether a port is free to listen on at 127.0.0.1, by trying it.
const portFree = (port) =>
    new Promise((resolve) => {
        const probe = createServer();
        probe.once("error", () => resolve(false));
        probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(() => resolve(true)));
    });

// The port a conversation's preview asks for first: the same one every time, so its origin (and the sign-in and look
// stored under it) survives a restart of its server.
export const preferredPort = (conversation) => {
    let hash = 0;
    for (const char of conversation) {
        hash = (hash * 31 + char.codePointAt(0)) % 1_000_003;
    }
    return PREVIEW_PORTS.first + (hash % (PREVIEW_PORTS.last - PREVIEW_PORTS.first + 1));
};

// The first free port in the preview range, starting at `from` and wrapping, that no live record claims; undefined
// when all are taken.
export const freePreviewPort = async (taken = new Set(), from = PREVIEW_PORTS.first, isFree = portFree) => {
    const span = PREVIEW_PORTS.last - PREVIEW_PORTS.first + 1;
    for (let step = 0; step < span; step += 1) {
        const port = PREVIEW_PORTS.first + ((from - PREVIEW_PORTS.first + step) % span);
        if (!taken.has(port) && (await isFree(port))) {
            return port;
        }
    }
    return undefined;
};
