import { z } from "zod";
import type { PersonaPowers } from "./personas.js";

// THE MOST A TURN'S TOOLS MAY BE, as the principals it acts for are held to it (docs/architecture/access.md): one answer
// per persona shelf, each an upper bound. A shelf left out is not limited. A persona's own shelves are posture and only
// narrow inside this; a conversation grant lifts what a persona withheld and never what a ceiling did.
// The same names and order as a persona's shelves (schemas/personas.ts PersonaPowersSchema), so one vocabulary covers
// both, with no defaults: an absent answer here is "no limit", where an absent shelf on a card is "on".
export const ToolCeilingSchema = z.object({
    files: z.enum(["none", "read", "write"]).optional().describe("The most it may do with files: nothing, look and search, or also create and change."),
    shell: z
        .boolean()
        .optional()
        .describe("False takes commands away, and with them the terminals and every tool on the image. The switch the strength of the others depends on."),
    code: z.boolean().optional().describe("False takes away writing and running a script."),
    web: z.boolean().optional().describe("False takes away fetching a page and searching the web."),
    browser: z.boolean().optional().describe("False takes away the credential-free browser."),
    delegate: z.boolean().optional().describe("False takes away spawning subagents and running workflows."),
    sandbox: z.boolean().optional().describe("False takes away changing the sandbox's own settings, manifests and public outbox."),
});
export type ToolCeiling = z.infer<typeof ToolCeilingSchema>;

// The shelves a ceiling answers, other than `files`, which is ranked rather than switched.
export const CEILING_SWITCHES = ["shell", "code", "web", "browser", "delegate", "sandbox"] as const;
export type CeilingSwitch = (typeof CEILING_SWITCHES)[number];

const FILES_RANK = { none: 0, read: 1, write: 2 } as const;
type FilesAnswer = keyof typeof FILES_RANK;

const lowerFiles = (left: FilesAnswer | undefined, right: FilesAnswer | undefined): FilesAnswer | undefined => {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return FILES_RANK[left] <= FILES_RANK[right] ? left : right;
};

/** Whether a ceiling limits anything at all; undefined and an empty one do not. */
export const ceilingLimits = (ceiling: ToolCeiling | undefined): boolean =>
    ceiling !== undefined && ((ceiling.files !== undefined && ceiling.files !== "write") || CEILING_SWITCHES.some((shelf) => ceiling[shelf] === false));

/**
 * Two ceilings held together: the lower answer of each shelf, so a turn acting for several principals is held to what
 * every one of them may. Undefined is no ceiling, and holding it beside another changes nothing.
 */
export const intersectCeilings = (left: ToolCeiling | undefined, right: ToolCeiling | undefined): ToolCeiling | undefined => {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    const files = lowerFiles(left.files, right.files);
    const held: ToolCeiling = files === undefined ? {} : { files };
    for (const shelf of CEILING_SWITCHES) {
        if (left[shelf] === false || right[shelf] === false) {
            held[shelf] = false;
        }
    }
    return held;
};

/** A persona's shelves held under a ceiling: each shelf the lower of the two, connector lists untouched. */
export const capPowers = (powers: PersonaPowers, ceiling: ToolCeiling | undefined): PersonaPowers => {
    if (!ceilingLimits(ceiling) || ceiling === undefined) {
        return powers;
    }
    const capped: PersonaPowers = { ...powers, files: lowerFiles(powers.files, ceiling.files) ?? powers.files };
    for (const shelf of CEILING_SWITCHES) {
        if (ceiling[shelf] === false) {
            capped[shelf] = false;
        }
    }
    return capped;
};

/** Whether a ceiling holds one shelf below what a grant would open it to (`files` opens to write). */
export const ceilingWithholds = (ceiling: ToolCeiling | undefined, shelf: "files" | CeilingSwitch): boolean => {
    if (ceiling === undefined) {
        return false;
    }
    return shelf === "files" ? ceiling.files !== undefined && ceiling.files !== "write" : ceiling[shelf] === false;
};

const SWITCH_WORDS = {
    shell: "no commands",
    code: "no scripts",
    web: "no web",
    browser: "no browser",
    delegate: "no subagents",
    sandbox: "no sandbox settings",
} as const satisfies Record<CeilingSwitch, string>;

/** What a ceiling withholds, in words its owner would recognise; empty when it limits nothing. */
export const ceilingWords = (ceiling: ToolCeiling | undefined): string[] => {
    if (ceiling === undefined) {
        return [];
    }
    const words: string[] = [];
    if (ceiling.files === "none") {
        words.push("no files");
    } else if (ceiling.files === "read") {
        words.push("read-only files");
    }
    for (const shelf of CEILING_SWITCHES) {
        if (ceiling[shelf] === false) {
            words.push(SWITCH_WORDS[shelf]);
        }
    }
    return words;
};
