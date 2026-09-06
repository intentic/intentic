import { extname } from "node:path";
import type { AgentEvent, ToolCallStatus } from "@intentic/sandbox-contract";

/* DID THIS TURN LOOK AT WHAT IT DREW?, the question `verify-edits` next door cannot ask.
 *
 * The proof ledger weighs edited code against the checks that ran, and for most changes that is the whole
 * story: a suite speaks to a parser, a reducer, a route. It says nothing at all about a rendered surface. A
 * stylesheet edit type-checks, keeps every test green, and ships a button with its label clipped; a `.vue`
 * template change passes lint and centres nothing. The turn ends reporting a green suite over work whose only
 * real acceptance test is a pair of eyes on a viewport.
 *
 * WHAT THIS LEDGER RECORDS is therefore a different pair of facts: which RENDERED SURFACES the turn edited, and
 * whether it OBSERVED anything in a browser afterwards. Same counter, same "after" rule, same reason: a
 * screenshot taken before the last three CSS edits is not evidence about them.
 *
 * WHY THE EXTENSION LIST IS AN ALLOWLIST, and the opposite call to the one agent-verification.ts makes for
 * prose. There, anything unrecognised is treated as code, because a missed nudge is a silent unverified change
 * and a spurious one costs a skipped ask. Here a spurious nudge costs a WHOLE MODEL TURN and a browser session,
 * so only files that are unambiguously a rendered surface count. A `.ts` file that changes what a component
 * does slips through, and that is the deliberate side to be wrong on.
 *
 * WHAT COUNTS AS LOOKING is narrower than "used a browser tool", and the narrowing is the point. Opening a page
 * and closing it, or resizing the window, is not evidence about a layout; navigating, screenshotting,
 * snapshotting the accessibility tree, reading the console, or evaluating against the DOM is. A gate that any
 * browser call could clear would be cleared by the turn that already fails it.
 *
 * IT ASKS FOR A COMPARISON, NOT A GLANCE. This is the half the sessions this was written from actually failed:
 * turns that got visually rejected had ALREADY taken a screenshot more often than turns that were accepted.
 * Looking is not the scarce thing; looking against a stated expectation is. So the follow-up asks the model to
 * name what it expected before it says what it saw, and to name the mismatch or say plainly there was none.
 *
 * Off by default, like every other rule that spends tokens on the owner's behalf (`verify-ui-edits`). */

// Files whose change is only really testable by rendering it. Anything not here is somebody else's question.
const SURFACE_EXTENSIONS = new Set([".vue", ".astro", ".svelte", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".styl", ".tsx", ".jsx"]);

// How many surfaces the follow-up names before it stops listing.
const NAMED_MAX = 8;

/* A tool call that OBSERVED the page, by the tail of its name. Matched on the tail rather than the whole thing
 * because the same browser tool arrives under a different prefix on every MCP server that offers one
 * (`mcp__web__browser_navigate`, `mcp__browser__browser_navigate`, a bare `browser_navigate` on a runtime that
 * flattens them), and the prefix is a deployment detail rather than a fact about the call. */
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
    // One browser observation. The name is kept for the message: "you ran browser_navigate" is checkable, and
    // an agent told something checkable about its own turn argues with it far less.
    readonly noteLook: (tool: string) => void;
    // Undefined ⇒ nothing to ask for: no surface was edited, or something was observed after the last one.
    readonly verdict: () => ViewVerdict | undefined;
    // Every surface this turn edited, whether or not it was since looked at. The reader rule conditions use,
    // for the same reason the proof ledger keeps one: `when: { paths: ["**/*.css"] }` has to fire on a turn
    // that did look.
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

/* THE SAME LEDGER, FED FRAMES, which is what makes this work on the five runtimes with no Stop hook. Every
 * adapter normalizes its native stream into the one `tool_call` vocabulary, so a Codex turn and a Claude turn
 * are the same shape here (agent/tool-calls.ts, and agent-verification.ts's createFrameLedger for the twin).
 *
 * A REFUSED OR FAILED CALL IS NOT EVIDENCE and did not edit anything, so both halves settle only on a terminal
 * status. A browser call that errored out did not show the agent the page. */
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
    // Same two readers agent-verification.ts uses: `locations` where the adapter derived them from the tool's
    // input, the structured diff otherwise, because an ACP agent sends the change and not its argument.
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

/* THE `verify-ui-edits` BUILT-IN, as one function: what this turn should be told, or nothing.
 *
 * No URL is invented. The daemon does not know how this workspace serves the view that changed, and a nudge
 * naming `localhost:3000` at a workspace that runs on 5173 reads as the check finding a bug. The agent knows,
 * or can find out, and is asked to. */
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
