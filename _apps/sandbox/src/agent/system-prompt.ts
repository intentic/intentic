import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { SystemPromptMode } from "@intentic/sandbox-contract";
import { INTENTIC_PROMPT } from "./intentic-prompt.js";

/* WHAT THE MODEL IS TOLD BEFORE THE CONVERSATION STARTS, and where each piece of it goes.
 *
 * Three bases, decided by one setting, and they do NOT split three ways — they split two.
 *
 * `intentic` (the default) and `claude` are peers: a base prompt, then the daemon's appends on top of it — the
 * widget guidance below, the delegation note, the terse steer. Only the base differs, and only in how it is
 * carried: Claude's preset is a flag the CLI expands on its way to the API (so its extras go in the SDK's
 * `append`), while Intentic's is text we ship, which reaches the same place as one concatenated string.
 *
 * `custom` is the odd one. That text IS the system prompt — no base, and none of the appends. It is honoured
 * literally rather than quietly softened, because a "replace" that still smuggles four blocks in is a setting
 * whose behaviour nobody can predict; the settings page states the cost at the moment of the edit instead.
 *
 * The one piece that survives `custom` is the delegation note, and only because it was never really
 * system-prompt content: it announces a capability (Codex is reachable through the shell) and it already has a
 * second home — the user-message preamble that `stableSystemPrompt` puts it in to protect the prompt cache. A
 * replaced prompt takes the same door. Nothing is invented for it; it reuses a path that already existed.
 *
 * ORDER, wherever appends happen, is most-stable-first: the guidance never changes, the note changes with which
 * accounts are connected, the terse steer with one toggle. The cached system+tools prefix survives a session
 * that way, which is the whole point of stableSystemPrompt. */

// Told to the model every turn, in every mode. The chat renders AskUserQuestion as a clickable card and
// ExitPlanMode as an approval card, but a model that doesn't know the widgets exist writes "A) … B) …" as
// prose instead — which is exactly the failure this text prevents. EnterPlanMode is named too, because the
// user's chosen mode is a starting posture, not a cage: the agent is expected to step up into planning when
// a request turns out to be bigger than it looked.
const INTERACTIVE_GUIDANCE = [
    "When a decision is genuinely the user's to make — an ambiguous requirement, a fork between real alternatives, a missing preference you cannot infer from the code — ask with the AskUserQuestion tool. It renders as a clickable card in the chat; options written as plain text do not, so the user cannot answer them by clicking. Do not use it for questions you can answer yourself by reading the workspace.",
    "When a request is large, risky, or underspecified, call EnterPlanMode first, investigate read-only, then ExitPlanMode to get your plan approved before changing anything.",
].join("\n\n");

// The checklist tools are DEFERRED — the model is told their names but not their schemas, so it must call
// ToolSearch before it can use one, and left to itself it never does: across a corpus of sandbox turns,
// TaskCreate was called zero times while the harness fired its "task list is empty" reminder on a loop. That
// silence costs the most exactly where it is worst — an unattended turn runs ~150 steps with no plan the
// operator can watch and nothing holding the agent to it — so this is told on EVERY turn, attended or not.
const CHECKLIST_GUIDANCE =
    "For any task worth more than a few steps, keep a checklist with the Task tools (load them with ToolSearch first: " +
    "`select:TaskCreate,TaskUpdate,TaskList`). Call TaskCreate once per step up front, TaskUpdate to move exactly one " +
    "task to in_progress before you start it and to completed the moment it is done. The user watches this list to see " +
    "where you are, so keep it current as you go rather than updating it in a batch at the end.";

// The browser tools are deferred (see isolatedBrowserSpec — ~20 tools is too much to pin into every prompt),
// and a model that does not know a browser exists never ToolSearches for one: it reaches for curl, gives up on
// anything client-rendered, or installs its own. Naming the server is what makes the capability discoverable.
// The closing sentence names the directory the redirect hook enforces, so it is a fact rather than a
// convention: the agent could not put a screenshot anywhere else if it tried. It used to promise the same
// directory while the tool wrote model-named files into the agent's cwd, which cost sessions a failed Read
// and a `find /` — and, when a session didn't check, left PNGs in the user's workspace (browser-artifacts.ts).
const browserGuidance = (outputDir: string | undefined): string =>
    "You have a real browser. Load it with ToolSearch (`+browser`) to get `mcp__web__browser_navigate`, " +
    "`mcp__web__browser_take_screenshot` and the rest — use it to read pages that need JavaScript, to check a " +
    "docs site, and to LOOK at web UI you have changed rather than reasoning about it from the source alone. " +
    `Screenshots land in ${outputDir ?? ".intentic/browser/output"} whatever you name them, never in the repo ` +
    "you are working in; the result tells you the path — Read it back from there.";

// The concise-response steer (terseOutput): cuts the model's OWN output tokens without dropping substance.
// Kept short so it barely costs tokens itself each turn.
const TERSE_NOTE =
    "Response style: be concise — don't restate the request, re-quote files you just read, or echo tool output the user can already see. Lead with the answer or the action; expand only where detail changes a decision.";

export interface TurnPromptInput {
    // SandboxSettings.systemPromptMode: which base this turn runs on.
    readonly mode: SystemPromptMode;
    // SandboxSettings.systemPrompt: the owner's text, meaningful only under "custom".
    readonly systemPrompt: string;
    // The cross-provider delegation how-to, when Codex/Grok are reachable at all.
    readonly note?: string;
    // Keep the system prefix byte-stable across the session by moving the note into the user message.
    readonly stableSystemPrompt: boolean;
    readonly terseOutput: boolean;
}

export interface TurnPromptPlacement {
    // The owner's replacement, under "custom" only. Undefined ⇒ the turn runs on a built-in base.
    readonly systemPrompt?: string;
    // What the daemon appends to a built-in base. Undefined ⇒ nothing to append (or nothing may be appended).
    readonly systemAppend?: string;
    // The delegation note when it cannot ride the system prompt, for the caller to prepend to the user message.
    readonly userNote?: string;
}

// Where each composed piece of this turn's instructions goes. One function because the three destinations are
// one decision: a note that rides the user message must NOT also ride the append, and a custom prompt takes
// both choices away at once.
export const turnPromptPlacement = ({ mode, systemPrompt, note, stableSystemPrompt, terseOutput }: TurnPromptInput): TurnPromptPlacement => {
    // Only "custom" replaces. Intentic's prompt is a BASE like Claude's preset — the daemon still appends to it,
    // which is what keeps the chat's cards working on the default setting.
    const replacing = mode === "custom";
    // The note goes to the user message when the system prompt is being kept byte-stable, and when there is no
    // daemon-controlled system prompt left to put it in.
    const noteInUserMessage = note !== undefined && (stableSystemPrompt || replacing);
    const append = replacing ? "" : [...(noteInUserMessage || note === undefined ? [] : [note]), ...(terseOutput ? [TERSE_NOTE] : [])].join("\n\n");
    return {
        ...(replacing ? { systemPrompt } : {}),
        ...(append === "" ? {} : { systemAppend: append }),
        ...(noteInUserMessage ? { userNote: note } : {}),
    };
};

export interface SdkSystemPromptInput {
    readonly mode: SystemPromptMode;
    // The owner's text, under "custom". It is then the whole prompt and every field below is moot.
    readonly custom: string | undefined;
    // What the turn composed for a built-in base (turnPromptPlacement's systemAppend).
    readonly append: string | undefined;
    // Nobody is watching: drop the interactive guidance, which describes widgets such a turn cannot use.
    readonly unattended: boolean;
    // Where the browser tools actually write screenshots, so the guidance states the enforced path rather than
    // a convention (browser-artifacts.ts redirects them there regardless).
    readonly browserOutputDir: string | undefined;
}

// This harness's own guidance, in most-stable-first order, with whatever the turn composed after it. Shared by
// both built-in bases so they differ only in the base itself — the guidance describes widgets THIS app renders,
// which is true whichever prompt the agent is wearing.
const harnessGuidance = ({ append, unattended, browserOutputDir }: Omit<SdkSystemPromptInput, "mode" | "custom">): string[] => [
    ...(unattended ? [] : [INTERACTIVE_GUIDANCE]),
    CHECKLIST_GUIDANCE,
    browserGuidance(browserOutputDir),
    ...(append === undefined ? [] : [append]),
];

/* The SDK's `systemPrompt` option for a turn.
 *
 * A STRING replaces Claude Code's preset outright (the SDK's documented behaviour) — which is how both
 * `intentic` and `custom` are carried, since neither wants the preset. They differ in what rides along:
 * Intentic's base is followed by the harness guidance, a custom prompt by nothing at all.
 *
 * The OBJECT form keeps the preset and hands the same guidance to the CLI's own `append`, which is the only way
 * to add to a prompt this process never sees the text of. */
export const sdkSystemPrompt = ({ mode, custom, ...extras }: SdkSystemPromptInput): NonNullable<Options["systemPrompt"]> => {
    if (mode === "custom") {
        // "" is a legal custom prompt — the owner emptied the box — and means exactly what it says: no system
        // prompt. The settings page is where that is argued with, not here.
        return custom ?? "";
    }
    if (mode === "intentic") {
        return [INTENTIC_PROMPT, ...harnessGuidance(extras)].join("\n\n");
    }
    return { type: "preset", preset: "claude_code", append: harnessGuidance(extras).join("\n\n") };
};
