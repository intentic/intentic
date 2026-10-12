import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { errorMessage } from "@intentic/base/errors";
import { homeDir } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract";
import { z } from "zod";
import { agentLogPath, baseDir, runLogPath } from "../../../config.js";
import { auditPath } from "../../config.js";
import { assertScope } from "../../policy.js";

/* THIS DEVICE'S OWN RECORDS, READ FROM THE SANDBOX (2026-10-11). The agent keeps its log (machine.log, rolled to
   machine.log.1), its update log, the audit of every call, and ic leaves one log per connect, recreate or update under
   ~/.intentic/logs. Nothing read them back: an agent debugging a device guessed paths with run_command, and read_file
   refused them outside the allowed folders (a distro's \\wsl.localhost path above all). The decisive line of more than
   one outage ("building the environment overlay … failed", a keeper restart) was only ever in one of these files. So
   they are listed and read by name here, never by path: only a file this agent itself names can be read, and a read is
   bounded like app_logs, since the answer crosses the same WebSocket as everything else. */

// How much of a file's end is read, and how many lines go back by default and at most. The schema is built from these.
export const LOG_TAIL_BYTES = 1024 * 1024;
export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2_000;
// How many of ic's logs the listing names: it leaves one per run, so a machine a year old holds hundreds.
const IC_LISTED = 40;

export type DeviceLogKind = "agent" | "agent-update" | "audit" | "ic";

export interface DeviceLog {
    // What the tool is asked for: the file's own name, or `ic/<name>` for one of ic's.
    readonly name: string;
    readonly path: string;
    readonly kind: DeviceLogKind;
    readonly size: number;
    readonly mtimeMs: number;
}

// Where ic writes its logs, as ic decides it (ic: logfile.rs, log_dir): INTENTIC_LOG_DIR, else ~/.intentic/logs.
export const icLogDir = (env: NodeJS.ProcessEnv = process.env, home: string = homeDir()): string => {
    const set = env["INTENTIC_LOG_DIR"];
    return set !== undefined && set !== "" ? set : join(home, STATE_DIR, "logs");
};

const KIND_PURPOSE = {
    agent: "this agent's own log: links, keeper, upkeep, restarts, the watchdog",
    "agent-update": "what an agent update or restart asked from a sandbox did",
    audit: "every tool call agents made here, one JSON line each (filter with `tool` or `failedOnly`)",
    ic: "one ic run (connect, recreate, update): docker builds and pulls end up here",
} satisfies Record<DeviceLogKind, string>;

// The agent's own files, in the order the listing shows them.
const agentFiles = (): readonly { readonly path: string; readonly kind: DeviceLogKind }[] => [
    { path: runLogPath, kind: "agent" },
    { path: `${runLogPath}.1`, kind: "agent" },
    { path: agentLogPath, kind: "agent-update" },
    { path: auditPath, kind: "audit" },
    { path: `${auditPath}.1`, kind: "audit" },
];

const statOf = async (path: string): Promise<{ size: number; mtimeMs: number } | undefined> => {
    // allow(silent-catch): a file that is not there is not listed
    const info = await stat(path).catch(() => undefined);
    return info?.isFile() === true ? { size: info.size, mtimeMs: info.mtimeMs } : undefined;
};

// Every record there is now: the agent's own that exist, then ic's, newest first. `dirs` is for the test's own home.
export const listDeviceLogs = async (dirs: { readonly ic?: string; readonly agent?: readonly { path: string; kind: DeviceLogKind }[] } = {}): Promise<DeviceLog[]> => {
    const own = await Promise.all(
        (dirs.agent ?? agentFiles()).map(async ({ path, kind }) => {
            const info = await statOf(path);
            return info === undefined ? undefined : { name: basename(path), path, kind, ...info };
        }),
    );
    const icDir = dirs.ic ?? icLogDir();
    // allow(silent-catch): no ic log folder is an ic that has not logged a run on this machine
    const names = await readdir(icDir).catch((): string[] => []);
    const ic = await Promise.all(
        names.map(async (file) => {
            const path = join(icDir, file);
            const info = await statOf(path);
            return info === undefined ? undefined : { name: `ic/${file}`, path, kind: "ic" as const, ...info };
        }),
    );
    return [
        ...own.filter((log) => log !== undefined),
        ...ic.filter((log) => log !== undefined).toSorted((a, b) => b.mtimeMs - a.mtimeMs),
    ];
};

const sizeText = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;

// The listing as the model reads it. Pure.
export const listingText = (logs: readonly DeviceLog[], icDir: string): string => {
    const ic = logs.filter((log) => log.kind === "ic");
    const row = (log: DeviceLog): string => `${log.name}  ${sizeText(log.size)}  modified ${new Date(log.mtimeMs).toISOString()}`;
    const own = logs.filter((log) => log.kind !== "ic");
    const kinds = [...new Set(own.map((log) => log.kind))];
    return [
        `This agent's records (${baseDir}):`,
        ...(own.length === 0 ? ["  (none yet)"] : own.map((log) => `  ${row(log)}`)),
        ...kinds.map((kind) => `  ${kind}: ${KIND_PURPOSE[kind]}`),
        "",
        `ic's logs (${icDir}), newest first:`,
        ...(ic.length === 0 ? ["  (none)"] : ic.slice(0, IC_LISTED).map((log) => `  ${row(log)}`)),
        ...(ic.length > IC_LISTED ? [`  …and ${ic.length - IC_LISTED} older`] : []),
        `  ic: ${KIND_PURPOSE.ic}`,
        "",
        "Read one with `name` (and `grep`, `lines`).",
    ].join("\n");
};

// The last LOG_TAIL_BYTES of a file as lines, the first dropped when the read started mid-line.
const tailOf = async (path: string): Promise<{ readonly lines: string[]; readonly size: number; readonly cut: boolean }> => {
    const handle = await open(path, "r");
    try {
        const { size } = await handle.stat();
        const from = Math.max(0, size - LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(size - from);
        await handle.read(buffer, 0, buffer.byteLength, from);
        const lines = buffer.toString("utf8").replace(/\r\n/g, "\n").split("\n");
        if (from > 0) {
            lines.shift();
        }
        if (lines.at(-1) === "") {
            lines.pop();
        }
        return { lines, size, cut: from > 0 };
    } finally {
        await handle.close();
    }
};

export interface LogFilter {
    readonly lines: number;
    readonly grep?: string | undefined;
    // audit.jsonl only: one tool's calls, and only the ones that failed or were refused.
    readonly tool?: string | undefined;
    readonly failedOnly?: boolean | undefined;
}

// One line of audit.jsonl as far as a filter reads it (audit.ts writes {at, tool, ok, detail}).
const AuditLineSchema = z.object({ tool: z.string(), ok: z.boolean() }).loose();

// Whether an audit line passes the audit filters; a line that is not the audit's JSON passes only an unfiltered read.
const auditPasses = (line: string, { tool, failedOnly }: LogFilter): boolean => {
    if (tool === undefined && failedOnly !== true) {
        return true;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        // allow(silent-catch): a torn line (a crash mid-write) is not a call, and a filtered read is about calls
        return false;
    }
    const entry = AuditLineSchema.safeParse(parsed);
    return entry.success && (tool === undefined || entry.data.tool === tool) && (failedOnly !== true || !entry.data.ok);
};

// The lines a read answers with, last `lines` of those that pass. Pure; throws on a grep that is not a pattern.
export const filterLines = (all: readonly string[], kind: DeviceLogKind, filter: LogFilter): string[] => {
    let pattern: RegExp | undefined;
    if (filter.grep !== undefined) {
        try {
            pattern = new RegExp(filter.grep, "i");
        } catch (error) {
            throw new Error(`grep is not a usable pattern: ${errorMessage(error)}`, { cause: error });
        }
    }
    return all.filter((line) => (pattern === undefined || pattern.test(line)) && (kind !== "audit" || auditPasses(line, filter))).slice(-filter.lines);
};

const filterText = (filter: LogFilter): string =>
    [
        ...(filter.grep === undefined ? [] : [`matching /${filter.grep}/i`]),
        ...(filter.tool === undefined ? [] : [`tool ${filter.tool}`]),
        ...(filter.failedOnly === true ? ["failed or refused only"] : []),
    ].join(", ");

// The same switches as a sandbox's own log (sandboxes.ts, readLogs): these are a way of seeing what this device did,
// which either "Run commands" or "Manage sandboxes on this device" already shows.
const assertReadable = (scopes: DeviceScopes): void => {
    if (scopes.shell !== "on") {
        assertScope(scopes, "sandboxes");
    }
};

// The tool: the listing without a name, else the tail of the record so named.
export const deviceLogs = async (name: string | undefined, filter: LogFilter, scopes: DeviceScopes): Promise<string> => {
    assertReadable(scopes);
    const logs = await listDeviceLogs();
    if (name === undefined) {
        return listingText(logs, icLogDir());
    }
    if ((filter.tool !== undefined || filter.failedOnly === true) && !name.startsWith("audit.jsonl")) {
        throw new Error("`tool` and `failedOnly` filter audit.jsonl's calls; for any other log use `grep`.");
    }
    const log = logs.find((candidate) => candidate.name === name);
    if (log === undefined) {
        throw new Error(`This device has no log called "${name}". Call device_logs with no name for the list.`);
    }
    const { lines, size, cut } = await tailOf(log.path);
    const shown = filterLines(lines, log.kind, filter);
    const how = filterText(filter);
    const head = `${log.path}, ${sizeText(size)}${cut ? `, its last ${sizeText(LOG_TAIL_BYTES)} read` : ""}${how === "" ? "" : `, ${how}`}:`;
    return shown.length === 0 ? `${head}\n(nothing${how === "" ? " in it yet" : " matches"})` : `${head}\n${shown.join("\n")}`;
};
