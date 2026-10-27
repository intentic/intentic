import type { InvitePreview } from "@intentic/api-contract";
import { DEMO_USER } from "./account";
import { joinRow, rowOf } from "./sandboxRegistry";

// AN INVITE THE VISITOR HOLDS. The demo has one person in it, so whoever opens an accept link (/demo/invite/:token) is
// the one it invites: ada, asked by Jo to the team's design sandbox as a collaborator. Accepting adds that sandbox to
// her list and opens it; the link then reads as accepted, and opening it again goes straight in, as the platform answers
// an accepted link again with the sandbox's id.

const INVITED_TO = `acme-design`;
const INVITED_AS = `collaborator` as const;

// The sandbox each accepted link joined, by token.
const accepted = new Map<string, string>();

/** invite.preview: what the accept page shows for a link. */
export const previewInvite = (token: string): InvitePreview => ({
    status: accepted.has(token) ? `accepted` : `pending`,
    sandboxName: INVITED_TO,
    invitedEmail: DEMO_USER.email,
    role: INVITED_AS,
});

/** invite.accept: the sandbox joins the list, once; a second accept answers the same sandbox. */
export const acceptInvite = (token: string): string => {
    const joined = accepted.get(token);
    if (joined !== undefined && rowOf(joined) !== undefined) {
        return joined;
    }
    const row = joinRow(INVITED_TO, INVITED_AS);
    accepted.set(token, row.id);
    return row.id;
};
