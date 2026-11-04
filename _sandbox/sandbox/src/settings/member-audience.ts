import { type Audience, AudienceSchema } from "@intentic/sandbox-contract/schemas/settings";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// The words a person chose for their own editor on this sandbox (developer or maker), by the address they signed in
// with. Everyone else follows the sandbox's mode (sandbox-mode.ts audienceOfMode): a hands-off sandbox speaks plain
// words, a hands-on one git's. A choice is kept where every device the person opens the sandbox on reads it, and never
// read for another member. An answer kept from before the mode (2026-11), when a browser asked once and handed its
// answer to every sandbox it opened, is read as that person's choice: it is what they said, and they can follow the
// sandbox again from Appearance. On the history volume, beside the other per-person records, so no address rides a
// tracked file. "" is the one person of a sandbox nobody signs in to (loopback).
export const memberAudienceDocument = defineDocument({
    root: "history",
    path: "member-audience.json",
    // Each person's own choice of which words their editor uses here (developer or maker), keyed by sign-in address.
    // Carried: it is theirs, and choosing again after a move would be a question already answered.
    portability: "carry",
    schema: z.object({ members: z.record(z.string(), AudienceSchema) }),
});

export interface MemberAudiences {
    readonly get: (member: string) => Promise<Audience | undefined>;
    // Replaces this person's choice, or with undefined forgets it so they follow the sandbox's mode again; answers the
    // choice that stands after the call.
    readonly choose: (member: string, audience: Audience | undefined) => Promise<Audience | undefined>;
}

export const fileMemberAudiences = (path: string): MemberAudiences => {
    // Absent or unreadable reads as nobody having chosen; the next choice writes a fresh file.
    const file = openDocument(memberAudienceDocument, path, { fallback: () => ({ members: {} }) });
    return {
        get: async (member) => (await file.read()).members[member],
        choose: async (member, audience) => {
            await file.update((state) => {
                const held = state.members[member];
                // The same reference writes nothing: a choice already made, or nothing to forget.
                if (held === audience) {
                    return state;
                }
                if (audience === undefined) {
                    return { members: Object.fromEntries(Object.entries(state.members).filter(([kept]) => kept !== member)) };
                }
                return { members: { ...state.members, [member]: audience } };
            });
            return audience;
        },
    };
};
