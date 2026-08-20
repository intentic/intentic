import type { HostHub } from "../hosts/host-hub.js";
import { isReadableName, skipReason } from "./scan-policy.js";

/* READING A SETUP OFF ONE OF THE OWNER'S OWN COMPUTERS, the path that deletes the packing step entirely.
 *
 * The whole instruction the card used to give ("run this archive command, find the file it made, bring it to
 * the machine your browser is on, pick it out of a file dialog") exists only because the bytes were on the
 * wrong computer. When that computer is already connected here as a `host` capability, they are not: the
 * daemon can walk the directory itself over the socket the machine holds open, and the owner clicks once.
 *
 * IT READS, IT NEVER RUNS. A shell command would be one call instead of many, and it is deliberately not used:
 * reads inside the machine's roots need no scope at all (see HostScopesSchema, "Reads are always allowed
 * within them"), while `shell` is a switch an owner may well have turned off, and asking for it to import a
 * folder would be asking for far more than the job needs. Walk-and-read works on a machine granted nothing but
 * the default.
 *
 * IT READS ONLY WHAT AN ADAPTER CAN CONSUME. Every file here costs a network round trip, so the extension
 * allowlist in scan-policy.ts is applied on the way in, unlike the archive path, which already holds the
 * bytes and can afford to be generous. Both paths share the SKIP policy, which is the half that matters: a
 * `credentials/` folder is never read here either.
 *
 * The result is the same `Files` map the archive reader produces, keyed the same way (relative, forward-slash),
 * so the adapters, the plan and the apply are untouched by which door the setup came through. */

// A machine that answers `list_dir` for one of these has that tool installed. Ordered: the first hit wins,
// which only matters for the rare machine running both.
export const SETUP_DIRS = [
    { source: "hermes", dir: ".hermes", anchor: "config.yaml" },
    { source: "openclaw", dir: ".openclaw", anchor: "openclaw.json" },
] as const;

export type SetupSource = (typeof SETUP_DIRS)[number]["source"];

// Bounds. A lived-in home is a few hundred files once the skipped segments are gone; past this something is
// wrong with the assumption and the walk should stop rather than hold a machine's socket open for minutes.
const MAX_FILES = 600;
const MAX_DEPTH = 6;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

interface DirEntry {
    readonly name: string;
    readonly kind: "directory" | "file" | "other";
    readonly size?: number;
}

export interface HostScan {
    readonly source: SetupSource;
    readonly files: ReadonlyMap<string, Buffer>;
    readonly skipped: readonly string[];
}

// Windows machines answer with backslash paths; the separator the home directory uses is the one the machine
// understands, so it is read off `home` rather than guessed from a platform string.
const separatorOf = (home: string): string => (home.includes("\\") && !home.startsWith("/") ? "\\" : "/");

/* One tool call to a machine, unwrapped. The hub throws its own readable sentence when the machine is offline;
 * an `isError` result is the machine refusing (a path outside its roots, a missing folder) and is thrown with
 * the machine's own words, because those are better than anything this file could invent. */
const callTool = async (hub: HostHub, id: string, name: string, args: Record<string, unknown>, seq: number): Promise<string> => {
    const answer = (await hub.mcp(id, { jsonrpc: "2.0", id: seq, method: "tools/call", params: { name, arguments: args } })) as {
        result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
        error?: { message?: string };
    };
    if (answer.error !== undefined) {
        throw new Error(answer.error.message ?? "the computer refused the request");
    }
    const text = answer.result?.content?.find((entry) => entry.type === "text")?.text ?? "";
    if (answer.result?.isError === true) {
        throw new Error(text === "" ? "the computer refused the request" : text);
    }
    return text;
};

const listDir = async (hub: HostHub, id: string, path: string, seq: number): Promise<DirEntry[]> => {
    const parsed: unknown = JSON.parse(await callTool(hub, id, "list_dir", { path }, seq));
    return Array.isArray(parsed) ? (parsed as DirEntry[]) : [];
};

/* Does this machine have a setup we could import? One `list_dir` per candidate directory, and a missing folder
 * is an ordinary "no" rather than an error, the probe runs on card render, for every connected machine, and
 * must be silent about the machines that have nothing.
 *
 * It confirms the ANCHOR file, not merely the folder: an empty `~/.openclaw` left behind by an uninstall would
 * otherwise offer an import that plans nothing. */
export const probeHost = async (hub: HostHub, id: string, home: string): Promise<SetupSource | undefined> => {
    const separator = separatorOf(home);
    for (const [index, candidate] of SETUP_DIRS.entries()) {
        const entries = await listDir(hub, id, `${home}${separator}${candidate.dir}`, index + 1).catch(() => undefined);
        if (entries?.some((entry) => entry.kind === "file" && entry.name === candidate.anchor) === true) {
            return candidate.source;
        }
    }
    return undefined;
};

// Walk one setup directory into the same map an uploaded archive produces. Breadth-first so the shallow files
// that decide the plan (the config, the bootstrap markdown) are read before a deep skills tree can exhaust the
// budget, a truncated walk then still yields a usable plan rather than a pile of skills and no config.
export const scanHost = async (hub: HostHub, id: string, home: string, source: SetupSource): Promise<HostScan> => {
    const candidate = SETUP_DIRS.find((entry) => entry.source === source) ?? SETUP_DIRS[0];
    const separator = separatorOf(home);
    const root = `${home}${separator}${candidate.dir}`;
    const files = new Map<string, Buffer>();
    const skipped = new Set<string>();
    let bytes = 0;
    let seq = 0;

    let frontier: { readonly abs: string; readonly rel: string }[] = [{ abs: root, rel: "" }];
    for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth += 1) {
        const next: { abs: string; rel: string }[] = [];
        for (const dir of frontier) {
            seq += 1;
            const entries = await listDir(hub, id, dir.abs, seq).catch(() => []);
            for (const entry of entries) {
                const rel = dir.rel === "" ? entry.name : `${dir.rel}/${entry.name}`;
                const skip = skipReason(rel, entry.size ?? 0);
                if (skip !== undefined) {
                    skipped.add(skip);
                    continue;
                }
                if (entry.kind === "directory") {
                    if (depth === MAX_DEPTH) {
                        skipped.add(`${rel}/ (nested deeper than this reader goes)`);
                        continue;
                    }
                    next.push({ abs: `${dir.abs}${separator}${entry.name}`, rel });
                    continue;
                }
                if (entry.kind !== "file") {
                    continue;
                }
                if (!isReadableName(entry.name)) {
                    skipped.add(rel);
                    continue;
                }
                if (files.size >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) {
                    skipped.add(`${rel} (past what this reader takes in one go)`);
                    continue;
                }
                seq += 1;
                // One unreadable file is not a failed import, a permission error on a stray file is recorded
                // and the walk carries on, which is the difference between importing 60 things and importing
                // nothing because of one.
                const text = await callTool(hub, id, "read_file", { path: `${dir.abs}${separator}${entry.name}` }, seq).catch(() => undefined);
                if (text === undefined) {
                    skipped.add(`${rel} (could not be read)`);
                    continue;
                }
                const content = Buffer.from(text, "utf8");
                bytes += content.byteLength;
                files.set(rel, content);
            }
        }
        frontier = next;
    }

    return { source, files, skipped: [...skipped].toSorted((left, right) => left.localeCompare(right)) };
};
