import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCapabilities, SystemPromptMode, TurnNote } from "@intentic/sandbox-contract";
import type { HostDeviceReach } from "../../hosts/self-host.js";
import type { OwnBrowserReach } from "../../webext/webext-peer.js";
import { PERSONA_NOTE_TITLE } from "../../personas/personas.js";
import { FIELD_NOTES_NOTE_TITLE } from "./field-notes.js";
import { guidanceBlock, type GuidanceVariant } from "./guidance.js";
import { intenticSystemPrompt } from "./intentic-prompt.js";
import { MEMORY_NOTE_TITLE } from "./workspace-memory.js";
import type { TurnPolicy, TurnSpec, TurnTools } from "../providers/agent-request.js";

// Three modes: `intentic` and `claude` share the same appends over a different base; `custom` replaces the prompt
// outright, nothing added. AgentCapabilities.instructions ("replace"/"append"/"none") decides how each of the six
// runtimes takes what is composed here. Appends are most-stable-first, so the cached system+tools prefix survives a
// session. The guidance itself is written in guidance.ts; this module only places it.

// One paragraph in place of a base prompt, for a window that cannot afford one (context-trim.ts decides when). Says
// only what a turn cannot work out from its own tools: where it is, that a person reads the reply, and that a small
// window is the constraint it is working under. Everything above is written for a model that can hold it.
export const SMALL_WINDOW_PROMPT =
    "You are a coding agent working in a sandboxed checkout of this workspace, on your own git branch. Use your " +
    "tools to read and change files rather than guessing at their contents, do what was asked and nothing beyond " +
    "it, and answer the person in a few sentences. Your context window is small: keep what you read narrow, and " +
    "do not re-read a file you have already seen.";

export interface TurnPromptInput {
    // `instructions` decides what may be placed; `runtime` decides if harness guidance already wraps it.
    readonly capabilities: AgentCapabilities;
    // SandboxSettings.systemPromptMode: which base this turn runs on.
    readonly mode: SystemPromptMode;
    // SandboxSettings.systemPrompt: the owner's text, meaningful only under "custom".
    readonly systemPrompt: string;
    // Keep the system prefix byte-stable across the session (nothing session-volatile enters the append).
    readonly stableSystemPrompt: boolean;
    // Rides the system append, even under stableSystemPrompt, since a persona doesn't change mid-session and changing
    // it mints a new prefix anyway. A runtime with no system seam sends it through the user message instead; a custom
    // prompt drops it like everything else appended.
    readonly personaNote?: string;
    // The workspace's own standing instructions (workspace-memory.ts), composed here rather than left to the runtime's
    // discovery. Same seams as the persona note, and the one thing a custom prompt does NOT drop: "nothing added" is
    // about this product's guidance, and these are the owner's own rules.
    readonly memoryNote?: string;
    // What past sessions here had to learn the hard way (field-notes.ts). Rides the same seams as the two above, and is
    // dropped by a custom prompt like the rest of this product's guidance: it is something Intentic worked out about
    // the sandbox, not something the owner wrote.
    readonly fieldNotesNote?: string;
    // What the model's declared window will not pay for (context-trim.ts). Structural rather than that module's own
    // type, so the prompt keeps no dependency on the decision that produced it — and so the decision can keep naming
    // its titles from here without the two importing each other.
    readonly trim?: PromptTrim;
    // Which variant of this product's guidance the turn drew (decide/experiments.ts); absent is the full set.
    readonly guidance?: GuidanceVariant;
}

// The prompt-side pieces a small window takes, as booleans rather than a tier: this module applies a decision, it does
// not re-make one. The field notes are not here because they are withheld a step earlier, where the turn decides
// whether to read them at all (decide/turn-facts.ts fieldNotesFor) — a brief that was never read cannot be placed.
export interface PromptTrim {
    // This product's own guidance paragraphs, both where the harness composes them and where they ride the append.
    readonly guidance: boolean;
    // The base prompt itself, swapped for SMALL_WINDOW_PROMPT. Only ever true on a runtime that replaces.
    readonly base: boolean;
}

export interface TurnPromptPlacement {
    // Owner's replacement under "custom"; undefined means the turn keeps whichever base it already had.
    readonly systemPrompt?: string;
    // What the daemon adds to that base. Undefined ⇒ nothing to add (or nothing may be added).
    readonly systemAppend?: string;
    // Notes that couldn't ride a system prompt, carried on the request's own notes (AgentRequest.notes) in read order;
    // a runtime with no system seam sends the persona note through here.
    readonly userNotes?: readonly TurnNote[];
}

// Joined in the order given, absent and empty pieces alike falling out, so each branch below reads as the ORDER it
// wants rather than as three spread-ternaries carrying it.
const joined = (parts: readonly (string | undefined)[]): string => parts.filter((part) => part !== undefined && part !== "").join("\n\n");

// The same list as notes, titled. Title and text travel as a pair so a note can never arrive under another's heading.
const titled = (entries: readonly (readonly [string, string | undefined])[]): TurnNote[] =>
    entries.flatMap(([title, text]) => (text === undefined ? [] : [{ title, text }]));

// A runtime with no system seam at all (Pi, ACP): the owner's prompt is not applied and the composer discloses that
// (limitationsOf), rather than quietly pasting it into the user message. The persona note and the workspace's standing
// instructions still have to arrive, so they go through the user message instead.
const messageNotes = (personaNote: string | undefined, fieldNotes: string | undefined, memoryNote: string | undefined): TurnPromptPlacement => {
    const userNotes = titled([
        // Who the turn is acting as comes first, as it does in the preamble: it decides what the rest is for.
        [PERSONA_NOTE_TITLE, personaNote],
        [FIELD_NOTES_NOTE_TITLE, fieldNotes],
        [MEMORY_NOTE_TITLE, memoryNote],
    ]);
    return userNotes.length === 0 ? {} : { userNotes };
};

// An absent trim read as one that takes nothing, so every branch below tests a plain boolean rather than an optional
// chain per piece.
const TAKES_NOTHING: PromptTrim = { guidance: false, base: false };

// The whole prompt, where something replaces the composed one: the owner's own text under `custom`, or the one
// paragraph a window too small for the loop's instructions leaves room for. `custom` is tested first and wins over a
// trim, because the owner's words are not this product's to shorten — a small window still takes the guidance, the
// field notes and the optional notes around them, just never the text the owner typed.
//
// The two pieces riding on the trimmed prompt, and why they survive a trim that takes everything else: the persona
// decides what the turn may DO, and the owner's rules are the owner's own words.
const ownPrompt = ({ mode, systemPrompt, personaNote, memoryNote }: TurnPromptInput): string =>
    mode === "custom" ? joined([systemPrompt, memoryNote]) : joined([SMALL_WINDOW_PROMPT, personaNote, memoryNote]);

// Where that replacement can go. On a runtime that can only add, it is appended since the base can't be dropped
// anyway; "" with no memory on a replacing runtime is a legal, deliberate empty prompt.
const replacing = (own: string, instructions: AgentCapabilities["instructions"]): TurnPromptPlacement =>
    instructions === "replace" ? { systemPrompt: own } : own === "" ? {} : { systemAppend: own };

// Decides where each composed piece goes. One function because the destinations are one decision: a note on the user
// message must not also ride the append, and a custom prompt removes both choices at once.
export const turnPromptPlacement = (input: TurnPromptInput): TurnPromptPlacement => {
    const { capabilities, mode, personaNote, memoryNote, fieldNotesNote } = input;
    const { instructions, runtime } = capabilities;
    const trim = input.trim ?? TAKES_NOTHING;

    if (instructions === "none") {
        return messageNotes(personaNote, fieldNotesNote, memoryNote);
    }

    // `trim.base` is only ever set for a replacing runtime, since on one that can only append there is no base to
    // swap — which is why a trimmed turn and a custom prompt take the same exit.
    if (mode === "custom" || trim.base) {
        return replacing(ownPrompt(input), instructions);
    }

    const append = joined([
        // The Claude Code loop composes its guidance itself (sdkSystemPrompt); every other runtime carries it here.
        runtime === "claude-code" || trim.guidance ? undefined : guidanceBlock(input.guidance ?? "full", undefined),
        personaNote,
        // Before the owner's rules and after this product's: what the sandbox learned about itself is context for the
        // rules, not a rule, and anything claiming to outrank the owner's own words would be reading its own promotion.
        fieldNotesNote,
        // Last, so the owner's rules sit closest to the conversation. Editing them mid-session mints a new prefix, the
        // same cost as changing the persona, which is why neither is held back by stableSystemPrompt.
        memoryNote,
    ]);
    return append === "" ? {} : { systemAppend: append };
};

export interface SdkSystemPromptInput {
    readonly mode: SystemPromptMode;
    // The turn's model, which decides the variant of Claude Code's preset the intentic base is cut from.
    readonly model?: string;
    // The owner's text, under "custom". It is then the whole prompt and every field below is moot.
    readonly custom: string | undefined;
    // What the turn composed for a built-in base (turnPromptPlacement's systemAppend).
    readonly append: string | undefined;
    // Nobody is watching: drop the interactive guidance, which describes widgets such a turn cannot use.
    readonly unattended: boolean;
    // Enforced screenshot path (browser-artifacts.ts redirects there), stated as fact, not convention.
    readonly browserOutputDir: string | undefined;
    // Whether an account stands behind the routed browser, so the browser sentence can name it. The `mcp__browser__`
    // schemas are deferred now, so this sentence is what tells a turn they exist.
    readonly browserAccounts?: boolean;
    // Whether turn-plan mounted the diagnostics server (withheld from a persona whose files power is `none`); the
    // sentence rides only where it's loadable.
    readonly diagnostics?: boolean;
    // Whether agent.ts mounted the terminal hand-off server (attended, tmux wrapper on); the sentence rides only where
    // it's loadable.
    readonly terminal?: boolean;
    // The devices this turn can act on; absent or `ids: []` ⇒ no sentence about running things out there at all.
    readonly hostDevices?: HostDeviceReach | undefined;
    // The owner's own browsers granted this turn: `browsers` get the connected paragraph, `unlisted` the absent one.
    readonly ownBrowsers?: OwnBrowserReach | undefined;
    // What the model's window will not pay for; carried this far so the composed prompt and the disclosed one shed the
    // same pieces.
    readonly trim?: PromptTrim;
    // Which variant of the guidance the planner chose; absent is the full set.
    readonly guidance?: GuidanceVariant;
}

// The turn fields the composed prompt reads, in the groups the request holds them in, so both readers — the adapter that
// sends the prompt and the disclosure that shows it (prompt-disclosure.ts) — map a request one way.
export interface PromptRequest {
    readonly spec: Pick<TurnSpec, "model" | "systemPromptMode" | "systemPrompt" | "systemAppend" | "contextTrim" | "guidance">;
    readonly policy: Pick<TurnPolicy, "unattended">;
    readonly tools: Pick<TurnTools, "browserOutputDir" | "browserAccounts" | "diagnostics" | "hostDevices" | "ownBrowsers">;
}

// Whether the routed browser has any account behind it, deciding if the system prompt names that server at all.
const holdsBrowserAccounts = (accounts: Record<string, string> | undefined): boolean => Object.keys(accounts ?? {}).length > 0;

// Whether the terminal hand-off server is mounted, kept as one predicate so the mount and its prompt sentence never
// drift; off when unattended or without the tmux wrapper.
export const terminalMounted = (request: Pick<PromptRequest, "policy">, tmuxEnabled: boolean): boolean =>
    tmuxEnabled && request.policy.unattended !== true;

// One request, one prompt input: the mapping every caller shares, so a field read differently by two of them can't
// make the prompt shown disagree with the prompt sent.
export const promptInputOf = ({ spec, policy, tools }: PromptRequest, terminal: boolean): SdkSystemPromptInput => ({
    mode: spec.systemPromptMode ?? "intentic",
    ...(spec.model === undefined ? {} : { model: spec.model }),
    custom: spec.systemPrompt,
    append: spec.systemAppend,
    unattended: policy.unattended === true,
    browserOutputDir: tools.browserOutputDir,
    browserAccounts: holdsBrowserAccounts(tools.browserAccounts),
    diagnostics: tools.diagnostics === true,
    terminal,
    hostDevices: tools.hostDevices,
    ownBrowsers: tools.ownBrowsers,
    ...(spec.contextTrim === undefined ? {} : { trim: spec.contextTrim }),
    ...(spec.guidance === undefined ? {} : { guidance: spec.guidance }),
});

// This product's guidance block, then whatever the turn composed. Shared by both built-in bases, so they differ only in
// the base itself; a window with no room for it drops the whole block, never a paragraph at a time.
export const harnessGuidance = ({
    append,
    trim,
    guidance = "full",
    unattended,
    browserOutputDir,
    browserAccounts,
    diagnostics,
    terminal,
    hostDevices,
    ownBrowsers,
}: Omit<SdkSystemPromptInput, "mode" | "model" | "custom">): string[] => [
    ...(trim?.guidance === true
        ? []
        : [
              guidanceBlock(guidance, {
                  unattended,
                  browserOutputDir,
                  browserAccounts: browserAccounts === true,
                  diagnostics: diagnostics === true,
                  terminal: terminal === true,
                  hostDevices,
                  ownBrowsers,
              }),
          ]),
    ...(append === undefined ? [] : [append]),
];

// A string replaces Claude Code's preset outright (the SDK's documented behaviour): how both `intentic` and `custom`
// are carried, though only intentic's is followed by harness guidance. The object form keeps the preset and hands
// guidance to the CLI's own `append` instead. `cwd` only says where the intentic base's probe is spawned.
export const sdkSystemPrompt = async (
    { mode, model, custom, ...extras }: SdkSystemPromptInput,
    cwd: string,
): Promise<NonNullable<Options["systemPrompt"]>> => {
    // A trimmed base takes the same exit as the owner's own prompt: `custom` carries the paragraph turnPromptPlacement
    // composed in place of the loop's instructions, persona and owner's rules already on it, and this product adds
    // nothing to either.
    if (mode === "custom" || extras.trim?.base === true) {
        // "" is a legal custom prompt (the owner emptied the box): no system prompt, not a fallback to a default.
        return custom ?? "";
    }
    if (mode === "intentic") {
        return [(await intenticSystemPrompt(cwd, model)).text, ...harnessGuidance(extras)].join("\n\n");
    }
    return { type: "preset", preset: "claude_code", append: harnessGuidance(extras).join("\n\n") };
};
