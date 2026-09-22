import type { BuiltinPromptText } from "@intentic/sandbox-contract";
import { presetSystemPrompt } from "./preset-prompt.js";

// Intentic's default agent system prompt: Claude Code's own preset, read live from the installed CLI (preset-prompt.ts),
// with the lines and sections below cut out. Claude Code renders a different preset per model, so a cut one variant
// lacks is simply not there to make. Harness guidance is appended separately, the same way as over Claude's preset
// (system-prompt.ts).

// Lines cut, each found by how it opens; a paragraph left with none drops out.
const CUT_LINES: readonly string[] = [
    // The CLI prefixes this line to any string prompt itself; kept, it would be said twice.
    "You are a Claude agent,",
    "You are an interactive agent",
    "IMPORTANT: Assist with",
    "Write code that reads like the surrounding code",
    "When you use a pronoun",
];

// Sections cut whole: the heading's paragraph through the last one before the next heading.
const CUT_SECTIONS: readonly string[] = [
    "# Environment",
    // Points at a memory directory the CLI names only beside its own preset, never beside a string prompt.
    "# auto memory",
];

const HEADING = "# ";

const paragraphsOf = (text: string): string[] =>
    text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.replace(/^\n+|\n+$/g, ""))
        .filter((paragraph) => paragraph !== "");

const headingOf = (paragraph: string): string | undefined => (paragraph.startsWith(HEADING) ? paragraph.split("\n", 1)[0] : undefined);

const cutLine = (line: string): boolean => CUT_LINES.some((opening) => line.startsWith(opening));

const keptLines = (paragraph: string): string =>
    paragraph
        .split("\n")
        .filter((line) => !cutLine(line))
        .join("\n");

export const intenticPromptOf = (preset: string): string => {
    const kept: string[] = [];
    let inCutSection = false;
    for (const paragraph of paragraphsOf(preset)) {
        const heading = headingOf(paragraph);
        if (heading !== undefined) {
            inCutSection = CUT_SECTIONS.includes(heading);
        }
        const rest = inCutSection ? "" : keptLines(paragraph);
        if (rest !== "") {
            kept.push(rest);
        }
    }
    return kept.join("\n\n");
};

// The cuts a preset has nothing for: across every model's variant, one missing everywhere is a CLI that reworded it.
export const missedCuts = (preset: string): string[] => {
    const paragraphs = paragraphsOf(preset);
    const lines = paragraphs.flatMap((paragraph) => paragraph.split("\n"));
    return [
        ...CUT_LINES.filter((opening) => !lines.some((line) => line.startsWith(opening))),
        ...CUT_SECTIONS.filter((section) => !paragraphs.some((paragraph) => headingOf(paragraph) === section)),
    ];
};

// Same version as the preset it was cut from, since that CLI build is what decides the text.
export const intenticSystemPrompt = async (cwd: string, model?: string): Promise<BuiltinPromptText> => {
    const preset = await presetSystemPrompt(cwd, model);
    return { text: intenticPromptOf(preset.text), version: preset.version };
};
