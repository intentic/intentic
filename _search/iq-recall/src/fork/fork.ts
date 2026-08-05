import { statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readLines } from "../transcript/line-reader.js";
import {
    aiTitleOf,
    fileTouchesOf,
    leafUuidOf,
    type Line,
    parseLine,
    parentUuidOf,
    timestampOf,
    typedPromptOf,
    typeOf,
    uuidOf,
} from "../transcript/lines.js";

export interface ForkOptions {
    readonly transcriptPath: string;
    // Uuid of the last INCLUDED user turn; omitted = fork the whole session at its current leaf.
    readonly atTurnUuid?: string;
    readonly dryRun?: boolean;
}

export interface ForkResult {
    readonly sessionId: string;
    readonly path: string;
    readonly keptLines: number;
    readonly droppedLines: number;
    readonly leafUuid: string;
    // Absolute paths the kept prefix read whose disk content changed since — the fork's beliefs about them
    // are outdated; re-read before trusting.
    readonly staleFiles: readonly string[];
}

// Bookkeeping lines that are either per-session state (rewritten fresh below) or out-of-band metadata keyed
// to dropped checkpoints. Everything else survives if it sits on the root→leaf parent chain.
const DROPPED_TYPES = new Set(["queue-operation", "file-history-snapshot", "mode", "ai-title", "last-prompt"]);

// Synthesize a forked transcript: the root→fork-point slice of a session under a fresh session id, written
// next to the source so `claude --resume <id>` opens it. Conversation uuids are kept — they only need to be
// unique within one file.
export const materializeFork = async (options: ForkOptions): Promise<ForkResult> => {
    interface Entry {
        readonly json: string;
        readonly line: Line;
    }
    const entries: Entry[] = [];
    const byUuid = new Map<string, Entry>();
    const turns: { uuid: string; parentUuid?: string; prompt: string }[] = [];
    let lastLeaf: string | undefined;
    let lastUuid: string | undefined;
    let title: string | undefined;
    for await (const { json } of readLines(options.transcriptPath, 0)) {
        const line = parseLine(json);
        if (line === undefined) {
            continue;
        }
        const entry: Entry = { json, line };
        entries.push(entry);
        const uuid = uuidOf(line);
        if (uuid !== undefined) {
            byUuid.set(uuid, entry);
            lastUuid = uuid;
        }
        const prompt = typedPromptOf(line);
        if (prompt !== undefined && uuid !== undefined) {
            const parentUuid = parentUuidOf(line);
            turns.push({ uuid, prompt, ...(parentUuid !== undefined ? { parentUuid } : {}) });
        }
        title = aiTitleOf(line) ?? title;
        lastLeaf = leafUuidOf(line) ?? lastLeaf;
    }
    if (turns.length === 0) {
        throw new Error(`no user turns in ${options.transcriptPath} — nothing to fork`);
    }
    let leaf: string;
    let lastPrompt: string;
    if (options.atTurnUuid === undefined) {
        leaf = lastLeaf ?? lastUuid!;
        lastPrompt = turns.at(-1)!.prompt;
    } else {
        const index = turns.findIndex((turn) => turn.uuid === options.atTurnUuid);
        if (index === -1) {
            throw new Error(`--at ${options.atTurnUuid} is not a user turn of this session`);
        }
        const next = turns[index + 1];
        if (next === undefined) {
            leaf = lastLeaf ?? lastUuid!;
        } else {
            if (next.parentUuid === undefined) {
                throw new Error(`turn after ${options.atTurnUuid} has no parent — cannot resolve the fork leaf`);
            }
            leaf = next.parentUuid;
        }
        lastPrompt = turns[index]!.prompt;
    }
    const chain = new Set<string>();
    for (let current: string | undefined = leaf; current !== undefined;) {
        const entry = byUuid.get(current);
        if (entry === undefined) {
            throw new Error(`fork chain broken at ${current} — transcript line missing or oversized`);
        }
        chain.add(current);
        current = parentUuidOf(entry.line);
    }
    const sessionId = randomUUID();
    const kept: string[] = [];
    const staleByPath = new Map<string, boolean>();
    for (const entry of entries) {
        const type = typeOf(entry.line);
        const uuid = uuidOf(entry.line);
        if ((type !== undefined && DROPPED_TYPES.has(type)) || uuid === undefined || !chain.has(uuid)) {
            continue;
        }
        kept.push(JSON.stringify({ ...entry.line, sessionId }));
        const ts = timestampOf(entry.line);
        for (const touch of fileTouchesOf(entry.line)) {
            let changed: boolean;
            try {
                changed = ts !== undefined && statSync(touch.path).mtimeMs > ts;
            } catch {
                changed = true;
            }
            staleByPath.set(touch.path, changed);
        }
    }
    kept.push(
        ...(title !== undefined ? [JSON.stringify({ type: "ai-title", aiTitle: `${title} (fork)`, sessionId })] : []),
        JSON.stringify({ type: "last-prompt", lastPrompt, leafUuid: leaf, sessionId }),
    );
    const path = join(dirname(options.transcriptPath), `${sessionId}.jsonl`);
    if (options.dryRun !== true) {
        writeFileSync(path, `${kept.join("\n")}\n`);
    }
    return {
        sessionId,
        path,
        keptLines: kept.length,
        droppedLines: entries.length - (kept.length - (title !== undefined ? 2 : 1)),
        leafUuid: leaf,
        staleFiles: [...staleByPath.entries()]
            .filter(([, changed]) => changed)
            .map(([touched]) => touched)
            .toSorted(),
    };
};
