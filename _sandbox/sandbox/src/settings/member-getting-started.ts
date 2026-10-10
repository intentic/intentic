import { type GettingStarted, GettingStartedSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// What each person said about the editor's getting-started checklist on this sandbox (put it away, passed a step over),
// by the address they signed in with, kept where every device they open the sandbox on reads it. Beside the audience on
// the history volume for the same reason: no address rides a tracked file. Whether a step is done is never kept: the
// editor reads that from the sandbox's own data. "" is the one person of a sandbox nobody signs in to (loopback).
export const memberGettingStartedDocument = defineDocument({
    root: "history",
    path: "member-getting-started.json",
    schema: z.object({ members: z.record(z.string(), GettingStartedSchema) }),
});

export interface MemberGettingStarted {
    readonly get: (member: string) => Promise<GettingStarted>;
    // Replaces this person's choices with these and answers what is kept.
    readonly set: (member: string, choices: GettingStarted) => Promise<GettingStarted>;
}

// Only what was said: an absent field and a false or empty one mean the same, so neither is written.
const said = (choices: GettingStarted): GettingStarted => {
    const skipped = [...new Set(choices.skipped ?? [])];
    return { ...(choices.hidden === true ? { hidden: true } : {}), ...(skipped.length > 0 ? { skipped } : {}) };
};

export const fileMemberGettingStarted = (path: string): MemberGettingStarted => {
    // Absent or unreadable reads as nobody having said anything; the next choice writes a fresh file.
    const file = openDocument(memberGettingStartedDocument, path, { fallback: () => ({ members: {} }) });
    return {
        get: async (member) => (await file.read()).members[member] ?? {},
        set: async (member, choices) => {
            const kept = said(choices);
            await file.update((state) => {
                const { [member]: _previous, ...others } = state.members;
                return { members: Object.keys(kept).length === 0 ? others : { ...others, [member]: kept } };
            });
            return kept;
        },
    };
};
