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
import { intenticSystemPrompt } from "./intentic-prompt.js";
import { presetSystemPrompt } from "./preset-prompt.js";
import { GUIDANCE_TITLE, harnessGuidance, type PromptRequest, promptInputOf, terminalMounted } from "./system-prompt.js";
import { MEMORY_NOTE_HEADER, MEMORY_NOTE_TITLE } from "./workspace-memory.js";

// Read off the request the adapter was handed, never recomposed from settings: what was sent, not what would be now.

// Each piece is found by the header it opens with, the same anchors turn-preamble.ts splits at.
const APPENDED: readonly { readonly header: string; readonly title: string; readonly source: PromptSectionSource }[] = [
    { header: PERSONA_NOTE_HEADER, title: PERSONA_NOTE_TITLE, source: "persona" },
    { header: FIELD_NOTES_NOTE_HEADER, title: FIELD_NOTES_NOTE_TITLE, source: "field-notes" },
    { header: MEMORY_NOTE_HEADER, title: MEMORY_NOTE_TITLE, source: "memory" },
];

// A header counts only at the start of a line.
const marksIn = (append: string): { readonly at: number; readonly title: string; readonly source: PromptSectionSource }[] =>
    APPENDED.flatMap(({ header, title, source }) => {
        const at = append.indexOf(header);
        return at === -1 || (at > 0 && append[at - 1] !== "\n") ? [] : [{ at, title, source }];
    }).toSorted((left, right) => left.at - right.at);

// Only `claude-code` takes a base from here; every other runtime keeps its own.
const baseOf = (capabilities: AgentCapabilities, request: PromptRequest, mode: SystemPromptMode, own: string, replaced: boolean): PromptBase => {
    if (replaced) {
        // `trimmed`, not `custom`, for text the owner never wrote.
        return { kind: mode === "custom" ? "custom" : "trimmed", text: own };
    }
    if (capabilities.runtime !== "claude-code") {
        return { kind: "runtime" };
    }
    // Text is filled in on read (withBaseText), from a probe of the installed CLI for the model the turn ran on.
    return { kind: mode === "claude" ? "claude" : "intentic", ...(request.model === undefined ? {} : { model: request.model }) };
};

export interface DisclosureInput {
    readonly capabilities: AgentCapabilities;
    readonly request: PromptRequest;
    // Epoch ms of the turn this was composed for.
    readonly at: number;
}

// The owner's text under `custom`, or the small-window paragraph (context-trim.ts), stands in the base's place.
const baseReplaced = (request: PromptRequest, mode: SystemPromptMode): boolean => mode === "custom" || request.contextTrim?.base === true;

// The harness composes its guidance itself (harnessGuidance) rather than in the append; a replaced base has none.
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
    // A replaced base on a replacing runtime carries the composition in the prompt itself, not the append.
    const append = (replaced ? request.systemPrompt : undefined) ?? request.systemAppend ?? "";
    const marks = marksIn(append);
    // Ahead of the first titled piece: the guidance, or the replacing prompt where there is one.
    const leading = append.slice(0, marks[0]?.at).trim();
    const base = baseOf(capabilities, request, mode, leading, replaced);
    const guidance = guidanceOf(input, leading, replaced);
    const sections: PromptSection[] = [
        ...(guidance === "" ? [] : [{ source: "guidance" as const, title: GUIDANCE_TITLE, text: guidance }]),
        ...marks.map(({ at: from, title, source }, index) => ({ source, title, text: append.slice(from, marks[index + 1]?.at).trim() })),
    ];
    return { at, runtime: capabilities.runtime, mode, base, sections };
};

// Fetched only when a reader opens one; nothing for a runtime that keeps its prompt to itself.
export const withBaseText = async (disclosure: SystemPromptDisclosure, cwd: string): Promise<SystemPromptDisclosure> => {
    const { kind, model } = disclosure.base;
    if (kind !== "intentic" && kind !== "claude") {
        return disclosure;
    }
    const read = kind === "intentic" ? intenticSystemPrompt : presetSystemPrompt;
    const base = await read(cwd, model).catch(() => undefined);
    return base === undefined ? disclosure : { ...disclosure, base: { ...disclosure.base, text: base.text } };
};
