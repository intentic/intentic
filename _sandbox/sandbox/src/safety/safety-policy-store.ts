import { readFile } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import { queueOnFile, writeFileAtomic } from "@intentic/base/fs";
import { DEFAULT_SAFETY_POLICY, type SafetyPolicy } from "@intentic/sandbox-contract/policy/safety-policy";

// The owner's safety policy on disk (.intentic/config/safety.md); the judge reads it before a flagged command. A text
// file, not a manifest: it travels verbatim, with no shape to validate. `custom` reflects whether the file exists, not
// a diff against the shipped default.
//
// What the judge reads is that file PLUS the lines the owner allowed with Always on permission cards. Those are owner-wide
// grants (personas/owner-grants.ts), kept off the workspace, listed and taken back under Access, and rendered here, after
// the owner's own text, in a form that depends on nothing but the lines. They are never written into the file: an agent
// edits it as freely as its owner, so a yes kept there was a yes anyone could add or erase.

export interface SafetyPolicyStore {
    // The owner's own policy as the Safety page shows and edits it: the file, or the shipped default when nobody has
    // written one. Without the lines allowed on cards.
    readonly get: () => Promise<SafetyPolicy>;
    // Text only, as the judge will read it: the owner's policy followed by the lines allowed on cards. The judge's prompt
    // has no use for provenance.
    readonly text: () => Promise<string>;
    readonly set: (text: string) => Promise<void>;
}

// The heading and blurb the lines allowed on cards are rendered under, after the owner's text.
export const GRANTED_HEADING = `## Allowed with Always on permission cards`;
const GRANTED_NOTE = `Lines the owner allowed with Always on a card, oldest first. They hold in every conversation until the owner takes one back under Access.`;

// The legacy heading and blurb a release before the owner-wide grants appended card-accepted lines under, into the
// owner's own file. Read only by the step that carries them out (personas/safety-card-lines.ts).
export const LEGACY_ADDED_HEADING = `## Added from permission cards`;
export const LEGACY_ADDED_NOTE = `Lines you accepted on a card, newest last. Edit or delete them like anything else here.`;

// Ensures the text ends with exactly one newline, so what follows cannot merge onto the last line.
const terminated = (text: string): string => (text.endsWith(`\n`) ? text : `${text}\n`);

// The owner's policy with the allowed lines after it, or the policy untouched when none were allowed. Depends on the
// lines and their order alone, so two readings of the same grants are the same text.
export const withGrantedLines = (policy: string, lines: readonly string[]): string =>
    lines.length === 0 ? policy : `${terminated(policy)}\n${GRANTED_HEADING}\n\n${GRANTED_NOTE}\n\n${lines.map((line) => `- ${line}`).join(`\n`)}\n`;

export const fileSafetyPolicyStore = (path: string, granted: () => Promise<readonly string[]> = async () => []): SafetyPolicyStore => {
    const read = async (): Promise<SafetyPolicy> => {
        // Only absence is the default: an owner's file that cannot be read must not be judged by as the shipped text.
        const text = await readFile(path, "utf8").catch(undefinedIfMissing);
        // An empty file is a policy (ask about nothing beyond the hard rule), not the absence of one.
        return text === undefined ? { text: DEFAULT_SAFETY_POLICY, custom: false } : { text, custom: true };
    };
    return {
        get: read,
        text: async () => withGrantedLines((await read()).text, await granted()),
        set: (text) => queueOnFile(path, () => writeFileAtomic(path, terminated(text))),
    };
};
