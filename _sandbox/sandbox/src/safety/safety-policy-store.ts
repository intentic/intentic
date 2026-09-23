import { readFile } from "node:fs/promises";
import { DEFAULT_SAFETY_POLICY, type SafetyPolicy } from "@intentic/sandbox-contract";
import { queueOnFile, writeTextFile } from "../store/text-file.js";

// The owner's safety policy on disk (.intentic/config/safety.md); the judge reads it before a flagged command. A text
// file, not a manifest: it travels verbatim, with no shape to validate. `custom` reflects whether the file exists, not
// a diff against the shipped default.

export interface SafetyPolicyStore {
    // The policy as the judge will read it: the file, or the shipped default when nobody has written one.
    readonly get: () => Promise<SafetyPolicy>;
    // Text only; the judge's prompt has no use for provenance.
    readonly text: () => Promise<string>;
    readonly set: (text: string) => Promise<void>;
    // Adds one line under its own heading, never the last section, so it cannot land under an unrelated one. Appends to
    // the shipped default when no file exists, keeping the rest of the default intact.
    readonly append: (line: string) => Promise<void>;
}

// Heading and blurb `append` writes under, once, the first time a policy gets a card-added line.
const ADDED_HEADING = `## Added from permission cards`;
const ADDED_NOTE = `Lines you accepted on a card, newest last. Edit or delete them like anything else here.`;

// Ensures the text ends with exactly one newline, so an append cannot merge onto the last line.
const terminated = (text: string): string => (text.endsWith(`\n`) ? text : `${text}\n`);

// Inserts a line under the added-lines heading (creating it if missing), never at the end of the file, so it lands in
// the section it is addressed to. Repeated appends land on that section's last line, stacking instead of drifting apart
// with blank lines.
export const withAddedLine = (text: string, line: string): string => {
    const bullet = `- ${line.trim()}`;
    const body = terminated(text);
    const at = body.indexOf(ADDED_HEADING);
    if (at === -1) {
        return `${body}\n${ADDED_HEADING}\n\n${ADDED_NOTE}\n\n${bullet}\n`;
    }
    const after = at + ADDED_HEADING.length;
    const next = body.indexOf(`\n## `, after);
    const end = next === -1 ? body.length : next + 1;
    const section = body.slice(at, end).replace(/\n+$/u, ``);
    return `${body.slice(0, at)}${section}\n${bullet}\n${next === -1 ? `` : `\n${body.slice(end)}`}`;
};

export const fileSafetyPolicyStore = (path: string): SafetyPolicyStore => {
    const read = async (): Promise<SafetyPolicy> => {
        const text = await readFile(path, "utf8").catch(() => undefined);
        // An empty file is a policy (ask about nothing beyond the hard rule), not the absence of one.
        return text === undefined ? { text: DEFAULT_SAFETY_POLICY, custom: false } : { text, custom: true };
    };
    return {
        get: read,
        text: async () => (await read()).text,
        set: (text) => queueOnFile(path, () => writeTextFile(path, terminated(text))),
        // Read and write on the file's queue: two cards accepted at once must both land.
        append: (line) =>
            queueOnFile(path, async () => {
                const { text } = await read();
                await writeTextFile(path, withAddedLine(text, line));
            }),
    };
};
