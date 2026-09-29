import { type Audience, AudienceSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// Which words each person's editor uses on this sandbox (developer or maker), by the address they signed in with: their
// own answer, kept where every device they open the sandbox on reads it, and never another member's. On the history
// volume, beside the other per-person records, so no address rides a tracked file. "" is the one person of a sandbox
// nobody signs in to (loopback).
export const memberAudienceDocument = defineDocument({
    root: "history",
    path: "member-audience.json",
    schema: z.object({ members: z.record(z.string(), AudienceSchema) }),
});

export interface MemberAudiences {
    readonly get: (member: string) => Promise<Audience | undefined>;
    // Replaces this person's answer, or with `offer` takes it only while they have none; what is kept, and whether this
    // call set it.
    readonly answer: (member: string, audience: Audience, offer: boolean) => Promise<{ readonly audience: Audience; readonly adopted: boolean }>;
}

export const fileMemberAudiences = (path: string): MemberAudiences => {
    // Absent or unreadable reads as nobody having answered; the next answer writes a fresh file.
    const file = openDocument(memberAudienceDocument, path, { fallback: () => ({ members: {} }) });
    return {
        get: async (member) => (await file.read()).members[member],
        answer: async (member, audience, offer) => {
            // What was kept before this call, read inside the same update so two devices answering at once cannot both win.
            const before: { held?: Audience } = {};
            await file.update((state) => {
                const held = state.members[member];
                if (held !== undefined) {
                    before.held = held;
                }
                // The same reference writes nothing: an offer met by a kept answer, or an answer already given.
                return (offer && held !== undefined) || held === audience ? state : { members: { ...state.members, [member]: audience } };
            });
            return offer && before.held !== undefined ? { audience: before.held, adopted: false } : { audience, adopted: true };
        },
    };
};
