import { join } from "node:path";
import { DEFAULT_SAFETY_POLICY } from "@intentic/sandbox-contract";
import { LEGACY_ADDED_HEADING, LEGACY_ADDED_NOTE } from "../safety/safety-policy-store.js";
import { stateRelPath } from "../state-paths.js";
import { defineStep } from "../store/evolution/state-steps.js";
import { commandPolicyLine, ownerGrantsDocument } from "./owner-grants.js";

// The lines a permission card's Always button appended to the owner's own `.intentic/config/safety.md`, under
// "## Added from permission cards", carried into the owner-wide grants (personas/owner-grants.ts) and taken out of the
// file. Until then they sat where an agent edits them as freely as its owner does, listed nowhere and taken back only by
// editing the file by hand. One-shot: the grants file existing is what says this ran, so a section an agent writes into
// the policy later stays what it is, plain text in the owner's file, and is never promoted into a grant. The file as it
// stood goes to the history volume's trash first (convergence.md, rule 5), swept after its keeping like the rest.

const SAFETY_POLICY = stateRelPath(".intentic/config/safety.md");

const SECTION_HEADING = new RegExp(`^${LEGACY_ADDED_HEADING}[ \\t]*$`, "mu");
const BULLET = /^- (.*)$/u;

export interface CardLines {
    // The accepted lines, oldest first, each as one line of prose and none twice.
    readonly lines: readonly string[];
    // The policy without them: anything else the owner wrote under that heading stays under it.
    readonly rest: string;
}

const squeezed = (text: string): string => `${text.replace(/\n{3,}/gu, `\n\n`).trimEnd()}\n`;

// Splits the card-added section off a policy; undefined when there is none or it holds no line.
export const takeCardLines = (text: string): CardLines | undefined => {
    const heading = SECTION_HEADING.exec(text);
    if (heading === null) {
        return undefined;
    }
    const bodyAt = heading.index + heading[0].length;
    const next = text.indexOf(`\n## `, bodyAt);
    const endAt = next === -1 ? text.length : next + 1;
    const lines: string[] = [];
    const left: string[] = [];
    for (const row of text.slice(bodyAt, endAt).split(`\n`)) {
        const bullet = BULLET.exec(row);
        const said = bullet === null ? `` : commandPolicyLine(bullet[1] ?? ``);
        if (bullet !== null) {
            if (said !== `` && !lines.includes(said)) {
                lines.push(said);
            }
        } else if (row.trim() !== `` && row.trim() !== LEGACY_ADDED_NOTE) {
            left.push(row);
        }
    }
    if (lines.length === 0) {
        return undefined;
    }
    const before = text.slice(0, heading.index);
    const after = text.slice(endAt);
    const section = left.length === 0 ? `` : `${LEGACY_ADDED_HEADING}\n\n${left.join(`\n`)}\n\n`;
    return { lines, rest: squeezed(`${before}${section}${after}`) };
};

export const safetyCardLinesStep = defineStep({
    id: "safety-card-lines-to-owner-grants",
    describe: "carries the lines accepted on permission cards out of the owner's safety.md into the owner-wide grants",
    plan: async ({ roots, read, kind }) => {
        const grants = join(roots.auth, ownerGrantsDocument.path);
        if ((await kind(grants)) !== undefined) {
            return undefined;
        }
        const policy = join(roots.workspace, SAFETY_POLICY);
        const text = await read(policy);
        const taken = text === undefined ? undefined : takeCardLines(text);
        const at = Date.now();
        const stored = { commandPolicy: (taken?.lines ?? []).map((line) => ({ line, at })) };
        const writes = new Map<string, string | undefined>([[grants, `${JSON.stringify(stored, undefined, 2)}\n`]]);
        if (text === undefined || taken === undefined) {
            return { changes: [`starts ${ownerGrantsDocument.path} with no line in it`], writes };
        }
        writes.set(join(roots.history, `trash/safety-before-card-lines-${at}.md`), text);
        // A file that only ever held the shipped text plus those lines was never the owner's: it goes, so the shipped text
        // applies again and follows the release.
        writes.set(policy, squeezed(taken.rest) === squeezed(DEFAULT_SAFETY_POLICY) ? undefined : taken.rest);
        return {
            changes: [
                `carries ${taken.lines.length} line(s) accepted on permission cards from ${SAFETY_POLICY} into ${ownerGrantsDocument.path}`,
                `keeps the policy as it was in the history volume's trash`,
            ],
            writes,
        };
    },
});
