import type { HostHub } from "../hosts/host-peer.js";
import { isReadableName, skipReason } from "./scan-policy.js";

// Reads a setup directly off a connected host device instead of requiring a manual pack-and-upload. Read-only, never
// shell: walking and reading needs no granted scope, unlike a shell command. Applies scan-policy.ts's extension
// allowlist on the way in, since each file costs a round trip; produces the same `Files` map the archive reader does.

// First directory that answers list_dir wins; only matters for a machine running both tools.
export const SETUP_DIRS = [
    { source: "hermes", dir: ".hermes", anchor: "config.yaml" },
    { source: "openclaw", dir: ".openclaw", anchor: "openclaw.json" },
] as const;

export type SetupSource = (typeof SETUP_DIRS)[number]["source"];

// A lived-in home fits well under these; past them, stop rather than hold the socket open for minutes.
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

// Separator is read off `home` itself (Windows answers backslash paths), not guessed from a platform string.
const separatorOf = (home: string): string => (home.includes("\\") && !home.startsWith("/") ? "\\" : "/");

// One unwrapped tool call; the hub already throws a readable sentence for offline. An `isError` result (a path outside
// roots, a missing folder) is thrown with the machine's own words, better than anything invented here.
const callTool = async (hub: HostHub, id: string, name: string, args: Record<string, unknown>, seq: number): Promise<string> => {
    const answer = (await hub.mcp(id, { jsonrpc: "2.0", id: seq, method: "tools/call", params: { name, arguments: args } })) as {
        result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
        error?: { message?: string };
    };
    if (answer.error !== undefined) {
        throw new Error(answer.error.message ?? "the device refused the request");
    }
    const text = answer.result?.content?.find((entry) => entry.type === "text")?.text ?? "";
    if (answer.result?.isError === true) {
        throw new Error(text === "" ? "the device refused the request" : text);
    }
    return text;
};

// At the reader's depth floor, a directory is recorded as skipped instead of queued, so the plan names what it didn't
// look at.
const queueDirectory = (next: { abs: string; rel: string }[], skipped: Set<string>, abs: string, rel: string, atFloor: boolean): void => {
    if (atFloor) {
        skipped.add(`${rel}/ (nested deeper than this reader goes)`);
        return;
    }
    next.push({ abs, rel });
};

const listDir = async (hub: HostHub, id: string, path: string, seq: number): Promise<DirEntry[]> => {
    const parsed: unknown = JSON.parse(await callTool(hub, id, "list_dir", { path }, seq));
    return Array.isArray(parsed) ? (parsed as DirEntry[]) : [];
};

// One list_dir per candidate directory; a missing folder is an ordinary no, since this runs on every card render.
// Confirms the anchor file, not just the folder, so an uninstalled leftover doesn't offer an empty import.
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

// Walks a setup directory into the same map an uploaded archive produces. Breadth-first, so the shallow files that
// decide the plan (config, bootstrap markdown) are read before a deep skills tree can exhaust the budget.
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
                    queueDirectory(next, skipped, `${dir.abs}${separator}${entry.name}`, rel, depth === MAX_DEPTH);
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
                // One unreadable file doesn't fail the import; recorded and the walk continues.
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
