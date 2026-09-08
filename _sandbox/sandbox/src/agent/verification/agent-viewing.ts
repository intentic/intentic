import { extname } from "node:path";
import type { AgentEvent, ToolCallStatus } from "@intentic/sandbox-contract";

// Records which rendered surfaces a turn edited and whether it observed one afterward, mirroring the proof ledger's
// after-rule. Extensions are an allowlist, since a spurious nudge costs a whole model turn and a browser session.
// Looking is narrower than any browser call, and asks for a stated expectation against what was seen, not a glance.

// Files only really testable by rendering; anything else is somebody else's question.
const SURFACE_EXTENSIONS = new Set([".vue", ".astro", ".svelte", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".styl", ".tsx", ".jsx"]);

// How many surfaces the follow-up names before it stops listing.
const NAMED_MAX = 8;

// Tool verbs that observed the page, matched on the tail since the prefix is a deployment detail.
const OBSERVING = ["navigate", "take_screenshot", "screenshot", "snapshot", "find", "evaluate", "console_messages", "read", "wait_for", "network_requests"];

const BROWSER_TOOL = /(?:^|__)(?:browser|playwright|puppeteer)_/i;

export const isObservingCall = (name: string): boolean => {
    if (!BROWSER_TOOL.test(name)) {
        return false;
    }
    const tail = name.slice(name.search(BROWSER_TOOL)).replace(/^__/, "");
    return OBSERVING.some((verb) => tail.endsWith(`_${verb}`) || tail.endsWith(verb));
};

export const isSurfacePath = (path: string): boolean => SURFACE_EXTENSIONS.has(extname(path.split("/").pop() ?? "").toLowerCase());

export interface ViewVerdict {
    // Rendered surfaces edited with nothing observed after them, newest last.
    readonly paths: readonly string[];
}

export interface ViewLedger {
    readonly noteEdit: (path: string) => void;
    // One browser observation; the tool name is kept so the message names something the agent can check.
    readonly noteLook: (tool: string) => void;
    // undefined means nothing to ask for: no surface edited, or something observed after the last edit.
    readonly verdict: () => ViewVerdict | undefined;
    // Every surface edited, whether looked at or not; reader rules like `when: paths` need this regardless.
    readonly edited: () => readonly string[];
}

export const createViewLedger = (): ViewLedger => {
    const edits: { path: string; at: number }[] = [];
    const looks: number[] = [];
    let counter = 0;
    return {
        noteEdit: (path) => {
            if (!isSurfacePath(path)) {
                return;
            }
            counter += 1;
            edits.push({ path, at: counter });
        },
        noteLook: () => {
            counter += 1;
            looks.push(counter);
        },
        edited: () => [...new Set(edits.map((edit) => edit.path))],
        verdict: () => {
            const last = edits.at(-1);
            if (last === undefined || looks.some((at) => at > last.at)) {
                return undefined;
            }
            return { paths: [...new Set(edits.map((edit) => edit.path))] };
        },
    };
};

// Same ledger, fed normalized tool_call frames, so a Codex turn and a Claude turn are the same shape here. A refused or
// failed call is not evidence and did not edit anything; both halves settle only on a terminal status.
export interface ViewFrameLedger extends ViewLedger {
    readonly note: (event: AgentEvent) => void;
}

type TrackedView = { readonly kind: "edit"; readonly paths: readonly string[] } | { readonly kind: "look"; readonly tool: string };

const trackedView = (event: Extract<AgentEvent, { kind: "tool_call" }>): TrackedView | undefined => {
    if (isObservingCall(event.name)) {
        return { kind: "look", tool: event.name };
    }
    if (event.category !== "edit") {
        return undefined;
    }
    // Same two readers agent-verification.ts uses: locations if the adapter derived them, else the structured diff.
    const located = (event.locations ?? []).map((location) => location.path);
    const diffed = (event.content ?? []).flatMap((entry) => (entry.type === "diff" ? [entry.path] : []));
    const touched = located.length > 0 ? located : diffed;
    return touched.length > 0 ? { kind: "edit", paths: touched } : undefined;
};

export const createViewFrameLedger = (): ViewFrameLedger => {
    const ledger = createViewLedger();
    const pending = new Map<string, TrackedView>();
    const settle = (id: string, status: ToolCallStatus | undefined): void => {
        if (status !== "completed" && status !== "failed") {
            return;
        }
        const call = pending.get(id);
        if (call === undefined) {
            return;
        }
        pending.delete(id);
        if (status !== "completed") {
            return;
        }
        if (call.kind === "look") {
            ledger.noteLook(call.tool);
            return;
        }
        for (const path of call.paths) {
            ledger.noteEdit(path);
        }
    };
    return {
        ...ledger,
        note: (event) => {
            if (event.kind === "tool_call_update") {
                settle(event.id, event.status);
                return;
            }
            if (event.kind !== "tool_call") {
                return;
            }
            const call = trackedView(event);
            if (call === undefined) {
                return;
            }
            pending.set(event.id, call);
            settle(event.id, event.status);
        },
    };
};

// The verify-ui-edits built-in, as one function. No URL is invented: the daemon doesn't know how this workspace serves
// the view, so a guessed port would read as the check finding a bug.
export const verifyUiEditsMessage = (ledger: ViewLedger): string | undefined => {
    const verdict = ledger.verdict();
    if (verdict === undefined) {
        return undefined;
    }
    const shown = verdict.paths.slice(0, NAMED_MAX).map((path) => `- ${path}`);
    const rest = verdict.paths.length - shown.length;
    return [
        `This turn changed a rendered surface and never looked at the result:`,
        [...shown, ...(rest > 0 ? [`- ... and ${rest} more`] : [])].join("\n"),
        "",
        `Open the affected view in the browser and check it. Whatever this workspace serves it on, you have the browser tools and the dev server; find the address rather than guessing one.`,
        "",
        `State the expectation BEFORE the observation: what should this look like if the change worked. Then what you actually see, and the gap between them, or plainly that there is none. A screenshot on its own is not the check — the failure this exists to catch is work that was screenshotted and approved by the agent that wrote it.`,
        `Check the things a diff cannot show: text that overflows or clips, elements off their baseline or centre, padding that is even on one side only, borders doubled or cut at a corner, and the layout at a narrow width as well as a wide one.`,
    ].join("\n");
};
