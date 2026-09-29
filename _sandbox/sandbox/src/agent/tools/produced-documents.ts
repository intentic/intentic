import { stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative } from "node:path";
import {
    type AgentEvent,
    DELIVERABLE_EXTENSIONS,
    deliverableKindOf,
    isLockedWorkspacePath,
    type ToolCallContent,
    type ToolCallLocation,
    type ToolCallStatus,
} from "@intentic/sandbox-contract";

// The documents a command wrote that a person would open (the deck a python script built, the PDF a converter printed),
// named on the command's own card as `locations` once it ends. An edit tool's card already names its file; a command's
// never did, so a turn whose deliverable came out of a script had nothing on record to show for it.
//
// Attributed the way the shell-edit tracker attributes a Bash edit (agent-shell-edits.ts): a deliverable whose inode
// changed after the command started was written by it. Candidates are the checkout's dirty files (which reaches a
// file the command never named) and any path the command or its output names (which reaches one git ignores). Runtime
// neutral: it reads the normalized frames, so a Codex or OpenCode turn gets the same as a Claude one. What it cannot
// see: a file written by a job left running after its call returned, and, on the shared tree, another conversation's
// deliverable written while this command ran, which the window cannot tell apart from this one's.

// Reads which deliverables changed since `since` (epoch ms), as workspace paths; `named` is text the command and its
// output said, searched for paths.
export type DocumentScan = (since: number, named: readonly string[]) => Promise<readonly string[]>;

// The window opens this much before the call's frame arrived: a runtime may report a command only as it starts it.
const START_SLACK_MS = 1_000;
// A scan that has not answered by then is dropped rather than holding the turn's end.
const SCAN_BUDGET_MS = 10_000;
// How much of a command's output is searched for names, from each end: a path is said at the start or in the summary.
const NAMED_EDGE_CHARS = 64_000;
// Names taken from one text, and files checked per command: a listing of a thousand PDFs is not a thousand outputs.
const MAX_NAMED = 64;
const MAX_CHECKED = 1_000;

const EXTENSIONS = DELIVERABLE_EXTENSIONS.join("|");
// A run of path characters ending in a deliverable's extension. Quotes, brackets, `=`, `,`, `;` and `|` end a name,
// so `--out=deck.pptx` and `"q3/report.pdf"` both come out whole; a name with a space in it comes out as its tail,
// which the stat below then rejects unless that tail is a file too.
const NAMED_PATH = new RegExp(String.raw`[^\s"'\`<>|;,()=]+\.(?:${EXTENSIONS})(?![\w-]|\.\w)`, "gi");

// Paths a text names that could be a deliverable, in the text's own spelling; a sentence's closing `.` is not part of
// one, a second extension (`deck.pptx.bak`) makes it another file. A URL is not a file here, whatever it ends in.
export const namedDocumentPaths = (text: string): string[] => {
    const searched = text.length > NAMED_EDGE_CHARS * 2 ? `${text.slice(0, NAMED_EDGE_CHARS)}\n${text.slice(-NAMED_EDGE_CHARS)}` : text;
    const names = new Set<string>();
    for (const match of searched.matchAll(NAMED_PATH)) {
        const name = match[0];
        if (!name.includes("://") && !name.startsWith("~")) {
            names.add(name);
        }
        if (names.size >= MAX_NAMED) {
            break;
        }
    }
    return [...names];
};

// A named path as a workspace path: absolute ones must lie under the root the agent sees, relative ones are taken from
// that root; either way it may not climb out of it.
const workspaceNamed = (name: string, root: string): string | undefined => {
    const bare = name.startsWith("file:") ? name.slice("file:".length) : name;
    const inside = isAbsolute(bare) ? relative(root, bare) : bare;
    const normal = posix.normalize(inside.replaceAll("\\", "/"));
    return normal === "." || normal.startsWith("../") || normal === ".." || isAbsolute(normal) ? undefined : normal.replace(/^\.\//, "");
};

// Where a turn's files are, twice: `localCwd` is the daemon's copy of its checkout (a worktree, or the workspace), the
// one it stats; `effectiveCwd` is the root the agent names paths from, which an anchored turn sees at another place.
export interface ScanPlace {
    readonly localCwd: string;
    readonly effectiveCwd: string;
}

// The scan a turn runs after each command, over `dirty` (checkoutDirtyPaths) and the names the command's text gave.
export const scanProducedDocuments =
    (place: ScanPlace, dirty: () => Promise<readonly string[]>): DocumentScan =>
    async (since, named) => {
        const candidates = new Set<string>();
        for (const path of await dirty().catch((): readonly string[] => [])) {
            if (deliverableKindOf(path) !== undefined) {
                candidates.add(path);
            }
        }
        for (const text of named) {
            for (const name of namedDocumentPaths(text)) {
                const path = workspaceNamed(name, place.effectiveCwd);
                if (path !== undefined) {
                    candidates.add(path);
                }
            }
        }
        const written = await Promise.all(
            [...candidates]
                .filter((path) => !isLockedWorkspacePath(path))
                .slice(0, MAX_CHECKED)
                .map(async (path) => {
                    try {
                        const file = await stat(join(place.localCwd, path));
                        // ctime, not mtime: a file moved into place keeps its mtime, and a copy may be told to.
                        return file.isFile() && file.ctimeMs >= since ? path : undefined;
                    } catch {
                        // Gone, or never there under that name: nothing to show.
                        return undefined;
                    }
                }),
        );
        return written.filter((path) => path !== undefined).sort();
    };

const settledStatus = (status: ToolCallStatus | undefined): boolean => status === "completed" || status === "failed";

const textOf = (content: readonly ToolCallContent[] | undefined): string =>
    (content ?? []).flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");

// A command still running: when it started, what it was, what it has said, and the files its card names so far.
interface RunningCommand {
    readonly since: number;
    readonly command: string;
    output: string;
    locations: ToolCallLocation[] | undefined;
}

type SettledCommand = RunningCommand & { readonly id: string };

// The commands still running, fed every frame; answers the command a frame settles, which is the one to scan for.
const commandsRunning = (now: () => number): ((event: AgentEvent) => SettledCommand | undefined) => {
    const running = new Map<string, RunningCommand>();
    return (event) => {
        if (event.kind === "tool_call") {
            if (event.category === "execute" && !settledStatus(event.status)) {
                running.set(event.id, { since: now() - START_SLACK_MS, command: event.target ?? "", output: textOf(event.content), locations: event.locations });
            }
            return undefined;
        }
        const call = event.kind === "tool_call_update" ? running.get(event.id) : undefined;
        if (event.kind !== "tool_call_update" || call === undefined) {
            return undefined;
        }
        // Snapshots, as the card takes them: whatever arrived last is what the card holds.
        call.output = event.content === undefined ? call.output : textOf(event.content);
        call.locations = event.locations ?? call.locations;
        if (!settledStatus(event.status)) {
            return undefined;
        }
        running.delete(event.id);
        return { ...call, id: event.id };
    };
};

// A scan that gives up after `ms`, answering nothing, so a stuck git never holds a turn's last frame.
const within = <T>(work: Promise<T>, ms: number, fallback: T): Promise<T> =>
    new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
        void work.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            },
        );
    });

// The scans a turn owes, and the updates their answers make: the card's locations plus what the command wrote.
const scansOwed = (scan: DocumentScan) => {
    const ready: AgentEvent[] = [];
    const owed = new Set<Promise<void>>();
    return {
        look: (call: SettledCommand): void => {
            const named = [call.command, call.output].filter((text) => text !== "");
            const done: Promise<void> = within(scan(call.since, named), SCAN_BUDGET_MS, []).then((paths) => {
                owed.delete(done);
                const known = call.locations ?? [];
                const added = paths.filter((path) => !known.some((location) => location.path === path));
                if (added.length > 0) {
                    ready.push({ kind: "tool_call_update", id: call.id, locations: [...known, ...added.map((path) => ({ path }))] });
                }
            });
            owed.add(done);
        },
        // The updates answered so far, each handed out once.
        ready: (): AgentEvent[] => ready.splice(0),
        settled: async (): Promise<void> => {
            await Promise.all(owed);
        },
    };
};

// The turn's frames with each finished command's documents named on its card: a `tool_call_update` carrying the card's
// locations plus the documents, sent once the scan answers. The command's own frames pass untouched and on time; the
// update follows at the next frame, and every one still owed is sent before `done`, so the turn's record holds it.
export async function* withProducedDocuments(frames: AsyncIterable<AgentEvent>, scan: DocumentScan, now: () => number = Date.now): AsyncGenerator<AgentEvent> {
    const settles = commandsRunning(now);
    const scans = scansOwed(scan);
    for await (const event of frames) {
        if (event.kind === "done") {
            await scans.settled();
        }
        yield* scans.ready();
        const settled = settles(event);
        if (settled !== undefined) {
            scans.look(settled);
        }
        yield event;
    }
    await scans.settled();
    yield* scans.ready();
}
