import type {
    AgentCapabilities,
    PromptBase,
    PromptSection,
    PromptSectionSource,
    SystemPromptDisclosure,
    SystemPromptMode,
} from "@intentic/sandbox-contract";
import { PERSONA_NOTE_HEADER, PERSONA_NOTE_TITLE } from "../../personas/personas.js";
import { tmuxRunEnabled } from "../tools/agent-terminals.js";
import { FIELD_NOTES_NOTE_HEADER, FIELD_NOTES_NOTE_TITLE } from "./field-notes.js";
import { INTENTIC_PROMPT } from "./intentic-prompt.js";
import { presetSystemPrompt } from "./preset-prompt.js";
import { GUIDANCE_TITLE, harnessGuidance, type PromptRequest, promptInputOf, terminalMounted } from "./system-prompt.js";
import { MEMORY_NOTE_HEADER, MEMORY_NOTE_TITLE } from "./workspace-memory.js";

// What a turn was told before the user's own words, said back so the chat can show it. The system prompt is the one
// part of a turn that never appears in the transcript, and most of it is composed here rather than written by anyone:
// a reader who cannot see it cannot tell an arriving AGENTS.md from a silently dropped one.
//
// Read off the request the adapter was handed, never recomposed from settings: this is what that turn was sent, not
// what the same turn would be sent if it were planned again now.

// The composed pieces, each read back by the header it opens with — the same anchors the user preamble is split at
// (turn-preamble.ts). A piece that stopped carrying its header would show here merged into the guidance above it,
// which is a visible gap rather than a silent loss.
const APPENDED: readonly { readonly header: string; readonly title: string; readonly source: PromptSectionSource }[] = [
    { header: PERSONA_NOTE_HEADER, title: PERSONA_NOTE_TITLE, source: "persona" },
    { header: FIELD_NOTES_NOTE_HEADER, title: FIELD_NOTES_NOTE_TITLE, source: "field-notes" },
    { header: MEMORY_NOTE_HEADER, title: MEMORY_NOTE_TITLE, source: "memory" },
];

// A header counts only at the start of a line, so a section quoting another's wording mid-sentence isn't mistaken for
// one.
const marksIn = (append: string): { readonly at: number; readonly title: string; readonly source: PromptSectionSource }[] =>
    APPENDED.flatMap(({ header, title, source }) => {
        const at = append.indexOf(header);
        return at === -1 || (at > 0 && append[at - 1] !== "\n") ? [] : [{ at, title, source }];
    }).toSorted((left, right) => left.at - right.at);

// Which prompt the additions ride on. Only `claude-code` takes a base from here at all; every other runtime keeps its
// own and is told so, rather than being shown a prompt it never ran.
const baseOf = (capabilities: AgentCapabilities, mode: SystemPromptMode, own: string, replaced: boolean): PromptBase => {
    if (replaced) {
        // Whichever seam carried it, the words that replaced the base are what sits ahead of the first composed piece:
        // the owner's under `custom`, and the one paragraph a window too small for the loop's instructions left room
        // for otherwise. Two kinds, not one, because "Your own prompt" over text the owner never wrote is a lie that
        // costs nothing to avoid.
        return { kind: mode === "custom" ? "custom" : "trimmed", text: own };
    }
    if (capabilities.runtime !== "claude-code") {
        return { kind: "runtime" };
    }
    // Intentic's is shipped text, filled in on read; Claude's is read from the installed CLI, which is a probe worth
    // paying only for a reader who opens it.
    return { kind: mode === "claude" ? "claude" : "intentic" };
};

export interface DisclosureInput {
    readonly capabilities: AgentCapabilities;
    readonly request: PromptRequest;
    // Epoch ms of the turn this was composed for.
    readonly at: number;
}

// Whether something stands in the base's place: the owner's text under `custom`, or the paragraph a window too small
// for the loop's own instructions was given instead (context-trim.ts). Either way the composition rides that string
// rather than the append, on a runtime that replaces.
const baseReplaced = (request: PromptRequest, mode: SystemPromptMode): boolean => mode === "custom" || request.contextTrim?.base === true;

// This product's own paragraphs as the one block they are in the prompt. The harness arm composes them itself
// (harnessGuidance) rather than carrying them in the append, which is why the two sources are joined here. A replaced
// base has none — `leading` there is the replacing prompt, already drawn as the base row — and a trimmed turn's
// harnessGuidance answers empty on its own.
const guidanceOf = ({ capabilities, request }: DisclosureInput, leading: string, replaced: boolean): string =>
    replaced
        ? ""
        : [
              ...(capabilities.runtime === "claude-code"
                  ? harnessGuidance({ ...promptInputOf(request, terminalMounted(request, tmuxRunEnabled())), append: undefined })
                  : []),
              ...(leading === "" ? [] : [leading]),
          ].join("\n\n");

export const promptDisclosure = (input: DisclosureInput): SystemPromptDisclosure => {
    const { capabilities, request, at } = input;
    const mode = request.systemPromptMode ?? "intentic";
    const replaced = baseReplaced(request, mode);
    // Which seam carried the composition: a replaced base on a runtime that replaces has the owner's standing rules
    // folded into the prompt itself, every other turn has everything in the append.
    const append = (replaced ? request.systemPrompt : undefined) ?? request.systemAppend ?? "";
    const marks = marksIn(append);
    // Whatever sits ahead of the first titled piece: the workspace guidance on a runtime that takes the append whole,
    // and the replacing prompt where there is one.
    const leading = append.slice(0, marks[0]?.at).trim();
    const base = baseOf(capabilities, mode, leading, replaced);
    const guidance = guidanceOf(input, leading, replaced);
    const sections: PromptSection[] = [
        ...(guidance === "" ? [] : [{ source: "guidance" as const, title: GUIDANCE_TITLE, text: guidance }]),
        ...marks.map(({ at: from, title, source }, index) => ({ source, title, text: append.slice(from, marks[index + 1]?.at).trim() })),
    ];
    return { at, runtime: capabilities.runtime, mode, base, sections };
};

// The base's own words, fetched only when a reader opens one: the shipped text for Intentic's, a probe of the
// installed CLI for Claude's (cached there), and nothing for a runtime that keeps its prompt to itself.
export const withBaseText = async (disclosure: SystemPromptDisclosure, cwd: string): Promise<SystemPromptDisclosure> => {
    if (disclosure.base.kind === "intentic") {
        return { ...disclosure, base: { ...disclosure.base, text: INTENTIC_PROMPT } };
    }
    if (disclosure.base.kind === "claude") {
        const preset = await presetSystemPrompt(cwd).catch(() => undefined);
        return preset === undefined ? disclosure : { ...disclosure, base: { ...disclosure.base, text: preset.text } };
    }
    return disclosure;
};
