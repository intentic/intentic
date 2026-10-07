import type { AgentEvent } from "@intentic/sandbox-contract";

// A page as the model is still writing it: the tool call's arguments stream in as JSON text a few characters at a time
// (`input_json_delta`), and the chat draws the page's markup as it arrives, the way it draws prose. This reads the
// `html` and `title` strings out of that partial JSON, one character at a time and never twice, and says what is new
// at most a few times a second; the frames it yields are live state only (`page_draft`), never transcript.

// Most frames per second a draft sends: the frame redraws on each, and a reader cannot follow more.
const EMIT_EVERY_MS = 150;

type State = "start" | "key" | "afterKey" | "value" | "string" | "other" | "afterValue" | "done";

// The string values of a flat JSON object, decoded as the text arrives. Only the keys asked for are kept; a value of any
// other shape is skipped over (nested objects and arrays included) without being held.
export class PartialJsonStrings {
    private state: State = "start";
    private key = "";
    private escape: string | undefined;
    // Nesting inside a skipped object or array, and whether the skip is inside one of its strings.
    private depth = 0;
    private skipString = false;
    private skipEscape = false;
    private readonly values = new Map<string, string>();
    private readonly complete = new Set<string>();

    constructor(private readonly wanted: ReadonlySet<string>) {}

    value(key: string): string | undefined {
        return this.values.get(key);
    }

    // Whether the key's string has closed, so a title is not drawn half-written.
    closed(key: string): boolean {
        return this.complete.has(key);
    }

    feed(text: string): void {
        for (const char of text) {
            this.step(char);
        }
    }

    private append(char: string): void {
        if (this.wanted.has(this.key)) {
            this.values.set(this.key, (this.values.get(this.key) ?? "") + char);
        }
    }

    // One escape's text once whole: `\n` and its kin at once, `\uXXXX` after its four digits.
    private decodeEscape(char: string): string | undefined {
        const pending = (this.escape ?? "") + char;
        if (pending.startsWith("u")) {
            if (pending.length < 5) {
                this.escape = pending;
                return undefined;
            }
            this.escape = undefined;
            const code = Number.parseInt(pending.slice(1), 16);
            return Number.isNaN(code) ? "" : String.fromCharCode(code);
        }
        this.escape = undefined;
        const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
        return simple[pending] ?? pending;
    }

    private step(char: string): void {
        switch (this.state) {
            case "start":
                if (char === "{") {
                    this.state = "afterValue";
                }
                return;
            case "afterValue":
                if (char === '"') {
                    this.state = "key";
                    this.key = "";
                } else if (char === "}") {
                    this.state = "done";
                }
                return;
            case "key":
                if (this.escape !== undefined) {
                    const decoded = this.decodeEscape(char);
                    if (decoded !== undefined) {
                        this.key += decoded;
                    }
                } else if (char === "\\") {
                    this.escape = "";
                } else if (char === '"') {
                    this.state = "afterKey";
                } else {
                    this.key += char;
                }
                return;
            case "afterKey":
                if (char === ":") {
                    this.state = "value";
                }
                return;
            case "value":
                if (char === '"') {
                    this.state = "string";
                    if (this.wanted.has(this.key)) {
                        this.values.set(this.key, "");
                    }
                } else if (char === "{" || char === "[") {
                    this.state = "other";
                    this.depth = 1;
                } else if (!/\s/.test(char)) {
                    this.state = "other";
                    this.depth = 0;
                }
                return;
            case "string":
                if (this.escape !== undefined) {
                    const decoded = this.decodeEscape(char);
                    if (decoded !== undefined) {
                        this.append(decoded);
                    }
                } else if (char === "\\") {
                    this.escape = "";
                } else if (char === '"') {
                    this.complete.add(this.key);
                    this.state = "afterValue";
                } else {
                    this.append(char);
                }
                return;
            case "other":
                this.skip(char);
                return;
            case "done":
                return;
        }
    }

    // A value that is not a string, passed over: a scalar ends at the next comma or brace, a nested one when it closes.
    private skip(char: string): void {
        if (this.skipString) {
            if (this.skipEscape) {
                this.skipEscape = false;
            } else if (char === "\\") {
                this.skipEscape = true;
            } else if (char === '"') {
                this.skipString = false;
            }
            return;
        }
        if (this.depth === 0) {
            if (char === ",") {
                this.state = "afterValue";
            } else if (char === "}") {
                this.state = "done";
            }
            return;
        }
        if (char === '"') {
            this.skipString = true;
        } else if (char === "{" || char === "[") {
            this.depth += 1;
        } else if (char === "}" || char === "]") {
            this.depth -= 1;
            if (this.depth === 0) {
                // The comma after it is passed over by `afterValue`, which waits for the next key's quote.
                this.state = "afterValue";
            }
        }
    }
}

// One page call's draft: what its arguments have said so far, and how much of it the chat already has.
class PageDraft {
    private readonly json = new PartialJsonStrings(new Set(["html", "title"]));
    private sent = 0;
    private titled = false;
    private lastAt = Number.NEGATIVE_INFINITY;

    constructor(readonly callId: string) {}

    feed(partial: string): void {
        this.json.feed(partial);
    }

    // The next stretch of markup, if there is one and the last was long enough ago (or `force`).
    next(now: number, force: boolean): Extract<AgentEvent, { kind: "page_draft" }> | undefined {
        const html = this.json.value("html") ?? "";
        const title = this.json.closed("title") && !this.titled ? this.json.value("title") : undefined;
        if ((html.length <= this.sent && title === undefined) || (!force && now - this.lastAt < EMIT_EVERY_MS)) {
            return undefined;
        }
        const at = this.sent;
        this.sent = html.length;
        this.lastAt = now;
        if (title !== undefined) {
            this.titled = true;
        }
        return { kind: "page_draft", callId: this.callId, at, text: html.slice(at), ...(title === undefined ? {} : { title }) };
    }
}

// Every page call the main thread is writing in the current message, by its content block's index; and every call that
// drew a draft, until its result says the page took over (or the call failed).
export class PageDrafts {
    private readonly byBlock = new Map<number, PageDraft>();
    private readonly open = new Set<string>();

    constructor(
        private readonly isPageTool: (name: string) => boolean,
        private readonly now: () => number = Date.now,
    ) {}

    // A new model message: its blocks count from zero again.
    reset(): void {
        this.byBlock.clear();
    }

    start(index: number, block: { readonly type?: string; readonly id?: string; readonly name?: string }): void {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && this.isPageTool(block.name)) {
            this.byBlock.set(index, new PageDraft(block.id));
        }
    }

    *delta(index: number, partial: string): Generator<AgentEvent> {
        const draft = this.byBlock.get(index);
        if (draft === undefined) {
            return;
        }
        draft.feed(partial);
        const frame = draft.next(this.now(), false);
        if (frame !== undefined) {
            this.open.add(draft.callId);
            yield frame;
        }
    }

    // The block closed: whatever is still unsaid goes now.
    *stop(index: number): Generator<AgentEvent> {
        const draft = this.byBlock.get(index);
        if (draft === undefined) {
            return;
        }
        this.byBlock.delete(index);
        const frame = draft.next(this.now(), true);
        if (frame !== undefined) {
            this.open.add(draft.callId);
            yield frame;
        }
    }

    // The call's result: the page itself has been drawn (or the call failed), so its draft goes.
    *settled(callId: string): Generator<AgentEvent> {
        if (this.open.delete(callId)) {
            yield { kind: "page_draft", callId, at: 0, text: "", done: true };
        }
    }
}
