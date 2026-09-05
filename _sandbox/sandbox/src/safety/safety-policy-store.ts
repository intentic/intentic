import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DEFAULT_SAFETY_POLICY, type SafetyPolicy } from "@intentic/sandbox-contract";

/* THE OWNER'S SAFETY POLICY ON DISK (.intentic/config/safety.md), the document the command judge reads before
 * every flagged command. See the contract's safety-policy.ts for what it governs and why it is prose.
 *
 * A TEXT FILE, NOT A MANIFEST, which is the one thing to know before editing this module. Every other store
 * here is `jsonFile`: parse, validate, fall back to defaults, report a problem when the shape is wrong. None of
 * that applies to a document whose reader is a model. There is no shape to be wrong, no key to misspell, and
 * nothing a schema could reject — the worst an owner can write is a policy that means something other than what
 * they intended, and no parser catches that. So the file travels verbatim in both directions, and the only
 * failure mode left is "it isn't there", which is not a failure: it means nobody has written one, and the
 * shipped default describes the behaviour a fresh sandbox already has.
 *
 * WHY `custom` IS REPORTED. The page needs to say which of the two the reader is looking at, and to offer
 * "reset to the shipped text" honestly. Derived from whether the file exists rather than by comparing against
 * the default, so an owner who edits the default down to one changed word still owns their copy.
 */

export interface SafetyPolicyStore {
    // The policy as the judge will read it: the file, or the shipped default when nobody has written one.
    readonly get: () => Promise<SafetyPolicy>;
    // Just the text, for the judge's prompt, which has no use for the provenance.
    readonly text: () => Promise<string>;
    readonly set: (text: string) => Promise<void>;
    /* ADD ONE LINE, which is what the permission card's "add this to my policy" button does. Appends under a
     * heading of its own rather than at the end of whatever section happens to be last: a line landing under
     * "On my devices" because that section was written last would silently change what it means.
     *
     * Appending to the SHIPPED text when there is no file yet is deliberate — the alternative is a file holding
     * one line, which reads as a policy that permits one thing and says nothing about anything else. The owner
     * clicked a button on a card; they did not ask to throw away the default posture. */
    readonly append: (line: string) => Promise<void>;
}

// The heading a card-added line lands under, and the sentence explaining where these came from, written once
// on the first append. The owner is free to move the lines elsewhere afterwards; nothing here reads it back.
const ADDED_HEADING = `## Added from permission cards`;
const ADDED_NOTE = `Lines you accepted on a card, newest last. Edit or delete them like anything else here.`;

// Atomic like every manifest write next door, and for the same reason (store/json-file.ts argues it): a reader
// must never catch a half-written policy, least of all the judge. The temp's tag goes in FRONT of the name so
// the watcher's prefix match cannot read it as a write to the policy itself.
const writeAtomic = async (path: string, text: string): Promise<void> => {
    const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, path);
};

// One trailing newline, always. A document that gets appended to needs to know where its last line ended, and
// "sometimes" is how you get two headings on one line three appends later.
const terminated = (text: string): string => (text.endsWith(`\n`) ? text : `${text}\n`);

/* WHERE A CARD-ADDED LINE GOES. Under the added-lines heading if the document already has one, at the very end
 * otherwise (creating the heading on the way).
 *
 * Placed INSIDE its own section rather than simply appended, because appending to the end of the file puts the
 * line under whichever heading happens to be last — and this document's sections are addressed to different
 * subjects ("In this sandbox", "On my devices"). A line meant for the sandbox landing under the machines
 * heading does not read as a mistake to the judge; it reads as a rule about the owner's laptop.
 *
 * The section ends at the next heading or at the end of the text, and the line is placed on the last non-empty
 * line of it, so repeated appends stack into one list instead of drifting apart with blank lines between them. */
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
        // An empty file is somebody having cleared the document, not somebody having written nothing: it means
        // "ask me about nothing beyond the hard rule", which is a policy, and the judge should read it as one.
        return text === undefined ? { text: DEFAULT_SAFETY_POLICY, custom: false } : { text, custom: true };
    };
    return {
        get: read,
        text: async () => (await read()).text,
        set: (text) => writeAtomic(path, terminated(text)),
        append: async (line) => {
            const { text } = await read();
            await writeAtomic(path, withAddedLine(text, line));
        },
    };
};
