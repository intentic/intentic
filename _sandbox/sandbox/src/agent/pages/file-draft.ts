import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { PartialJsonStrings, type StreamedDrafts } from "./page-draft.js";
import { workspacePath } from "../../sessions/vocabulary/tool-calls.js";

// A file as the model is still writing it: a Write's content or an Edit's replacement streams into the call's arguments
// a few characters at a time (`input_json_delta`), the way a page's markup does (pages/page-draft.ts), and a viewer
// open on that file draws it as a draft over what is on disk. Nothing is said until the call has named its file, and
// only for a file inside the workspace, named as the call's card names it (tool-calls.ts `workspacePath`). The frames
// are live state only (`file_draft`), never transcript, and speculative: the call may still be refused or fail, which
// is why each draft ends with `done` when its result arrives and the file on disk takes over.

type FileDraftFrame = Extract<AgentEvent, { kind: "file_draft" }>;

// Most frames per second a draft sends, as a page's: the viewer redraws the file on each.
const EMIT_EVERY_MS = 150;

// The most of one draft's text that is streamed. A draft is a preview, and a big generated file would cost every
// window following the turn a copy of it (facts replay to a late joiner); past this the file on disk is the answer.
export const FILE_DRAFT_MAX_CHARS = 256 * 1024;

// Which tools write a file through their arguments, and under which keys. The native Write and Edit, and the hashline
// tools' whole-file write (hashline/hashline-tools.ts), which stands in for Write when that toggle is on; a hashline
// edit names lines by tag rather than text, so it has no draft to draw.
interface FileTool {
    readonly op: FileDraftFrame["op"];
    readonly path: string;
    readonly text: string;
    readonly old?: string;
    readonly replaceAll?: string;
}
const FILE_TOOLS: ReadonlyMap<string, FileTool> = new Map<string, FileTool>([
    ["Write", { op: "write", path: "file_path", text: "content" }],
    ["Edit", { op: "edit", path: "file_path", text: "new_string", old: "old_string", replaceAll: "replace_all" }],
    ["mcp__hashline__write", { op: "write", path: "path", text: "content" }],
]);

// One call's draft: what its arguments have said so far, and how much of it the viewers already have.
class FileDraft {
    private readonly json: PartialJsonStrings;
    private sent = 0;
    // Whether the first frame (an edit's `old`) and the edit's scope have been said.
    private opened = false;
    private allSaid = false;
    private truncated = false;
    private lastAt = Number.NEGATIVE_INFINITY;
    // The file, once the call named one inside the workspace; null when it named one outside, which never drafts.
    private file: string | null | undefined;

    constructor(
        readonly callId: string,
        private readonly tool: FileTool,
        private readonly cwd: string,
    ) {
        this.json = new PartialJsonStrings(new Set([tool.path, tool.text, ...(tool.old === undefined ? [] : [tool.old]), ...(tool.replaceAll === undefined ? [] : [tool.replaceAll])]));
    }

    feed(partial: string): void {
        this.json.feed(partial);
    }

    // The file this draft writes, once it is known; what the `done` frame names too.
    get path(): string | undefined {
        return this.file ?? undefined;
    }

    get op(): FileDraftFrame["op"] {
        return this.tool.op;
    }

    // The next stretch of text, if there is one and the last was long enough ago (or `force`).
    next(now: number, force: boolean): FileDraftFrame | undefined {
        if (this.truncated || (!force && now - this.lastAt < EMIT_EVERY_MS)) {
            return undefined;
        }
        const path = this.resolvePath();
        const old = this.oldText();
        if (path === undefined || old === null) {
            return undefined;
        }
        const text = this.json.value(this.tool.text) ?? "";
        const replaceAll = this.replaceAllNow();
        // An edit whose old text outgrew the cap drafts nothing: its replacement could not be placed anyway.
        const oldTooBig = (old?.length ?? 0) > FILE_DRAFT_MAX_CHARS;
        const overflow = oldTooBig || text.length > FILE_DRAFT_MAX_CHARS;
        const upTo = oldTooBig ? this.sent : Math.min(text.length, FILE_DRAFT_MAX_CHARS);
        if (this.opened && upTo <= this.sent && replaceAll === undefined && !overflow) {
            return undefined;
        }
        const frame: FileDraftFrame = { kind: "file_draft", callId: this.callId, path, op: this.tool.op, at: this.sent, text: text.slice(this.sent, upTo) };
        // Sent once, on the first frame, and only when small enough to be any use.
        if (!this.opened && old !== undefined && !oldTooBig) {
            frame.old = old;
        }
        if (replaceAll === true) {
            frame.replaceAll = true;
        }
        if (overflow) {
            frame.truncated = true;
        }
        this.opened = true;
        this.sent = Math.max(this.sent, upTo);
        this.lastAt = now;
        this.truncated = overflow;
        return frame;
    }

    // An edit's old text once whole, null while it is still streaming; undefined for a write, which replaces nothing.
    private oldText(): string | null | undefined {
        if (this.tool.old === undefined) {
            return undefined;
        }
        return this.json.closed(this.tool.old) ? (this.json.value(this.tool.old) ?? "") : null;
    }

    // Whether the edit replaces every occurrence, the first time its argument has ended; undefined otherwise.
    private replaceAllNow(): boolean | undefined {
        if (this.allSaid || this.tool.replaceAll === undefined) {
            return undefined;
        }
        const literal = this.json.scalar(this.tool.replaceAll);
        if (literal === undefined) {
            return undefined;
        }
        this.allSaid = true;
        return literal === "true" ? true : undefined;
    }

    private resolvePath(): string | undefined {
        if (this.file === undefined && this.json.closed(this.tool.path)) {
            this.file = workspacePath(this.json.value(this.tool.path) ?? "", this.cwd) ?? null;
        }
        return this.file ?? undefined;
    }
}

// Every file call a thread is writing in its current message, by thread and content block index; and every call that
// drew a draft, until its result says the file took over. A delegated subagent streams its own messages beside the main
// thread's (its frames carry the call that started it), whose block indexes count from zero too, hence the thread in
// the key.
export class FileDrafts {
    private readonly byBlock = new Map<string, FileDraft>();
    private readonly open = new Map<string, { readonly path: string; readonly op: FileDraftFrame["op"] }>();

    constructor(
        // The turn's working dir, which a call's path resolves against, as its card's locations do.
        private readonly cwd: string,
        private readonly now: () => number = Date.now,
    ) {}

    // One thread's view, fed that thread's stream events (pages/page-draft.ts streamedDraftFrames); undefined is the
    // main thread, a subagent's is the call that started it.
    thread(thread: string | undefined): StreamedDrafts {
        return {
            reset: () => this.reset(thread),
            start: (index, block) => this.start(thread, index, block),
            delta: (index, partial) => this.delta(thread, index, partial),
            stop: (index) => this.stop(thread, index),
        };
    }

    // A new model message on this thread: its blocks count from zero again.
    reset(thread: string | undefined): void {
        const prefix = `${thread ?? ""}\n`;
        for (const key of this.byBlock.keys()) {
            if (key.startsWith(prefix)) {
                this.byBlock.delete(key);
            }
        }
    }

    start(thread: string | undefined, index: number, block: { readonly type?: string; readonly id?: string; readonly name?: string }): void {
        const tool = block.name === undefined ? undefined : FILE_TOOLS.get(block.name);
        if (block.type === "tool_use" && block.id !== undefined && tool !== undefined) {
            this.byBlock.set(keyOf(thread, index), new FileDraft(block.id, tool, this.cwd));
        }
    }

    *delta(thread: string | undefined, index: number, partial: string): Generator<AgentEvent> {
        const draft = this.byBlock.get(keyOf(thread, index));
        if (draft === undefined) {
            return;
        }
        draft.feed(partial);
        yield* this.said(draft, draft.next(this.now(), false));
    }

    // The block closed: whatever is still unsaid goes now.
    *stop(thread: string | undefined, index: number): Generator<AgentEvent> {
        const key = keyOf(thread, index);
        const draft = this.byBlock.get(key);
        if (draft === undefined) {
            return;
        }
        this.byBlock.delete(key);
        yield* this.said(draft, draft.next(this.now(), true));
    }

    // The call's result: the file is written (or the call was refused or failed), so its draft goes.
    *settled(callId: string): Generator<AgentEvent> {
        const draft = this.open.get(callId);
        if (draft !== undefined) {
            this.open.delete(callId);
            yield { kind: "file_draft", callId, path: draft.path, op: draft.op, at: 0, text: "", done: true };
        }
    }

    private *said(draft: FileDraft, frame: FileDraftFrame | undefined): Generator<AgentEvent> {
        if (frame !== undefined && draft.path !== undefined) {
            this.open.set(draft.callId, { path: draft.path, op: draft.op });
            yield frame;
        }
    }
}

const keyOf = (thread: string | undefined, index: number): string => `${thread ?? ""}\n${index}`;
