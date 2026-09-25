import { extname } from "node:path";
import type { AgentEvent, ToolCallStatus } from "@intentic/sandbox-contract";

// Records which rendered surfaces a turn edited and whether it observed one afterward, mirroring the proof ledger's
// after-rule. What it finds is recorded on the conversation's card (AgentSummary.proof, turn-settlement.ts), never sent
// back to the model: checks run after work lands, and whether to look is the model's call. Extensions are an allowlist,
// so the card never badges a file nobody could render.

// Files only really testable by rendering; anything else is somebody else's question.
const SURFACE_EXTENSIONS = new Set([".vue", ".astro", ".svelte", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".styl", ".tsx", ".jsx"]);

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
