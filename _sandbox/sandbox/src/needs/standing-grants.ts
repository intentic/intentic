import type { GrantRevoke, StandingGrants } from "@intentic/sandbox-contract";
import type { ConversationGrants } from "../personas/conversation-grants.js";
import type { CredentialGrants } from "../secrets/credential-grants.js";
import { publishRuntimeChange } from "../seams/runtime-feed.js";

// The yeses still standing (docs/architecture/needs.md): what a grant need's "Allow for this conversation" widened, and
// which gated credentials a release need let through, and whether its installs run unasked, by conversation, where a
// person reviews and takes them back. A grant is read as a turn is planned and a release mounts at the next turn; the
// install grant is read at each install, so taking it back asks again from the next one. A credential gateway rule's pass
// is read as each request arrives, so taking it back asks again at the next one.

export interface StandingGrantsDeps {
    readonly conversationGrants: ConversationGrants;
    readonly credentialGrants: CredentialGrants;
}

type StandingConversation = StandingGrants["conversations"][number];

const lastChange = (conversation: StandingConversation): number =>
    Math.max(conversation.updatedAt ?? 0, ...conversation.releases.map((release) => release.at));

export const standingGrants = async ({ conversationGrants, credentialGrants }: StandingGrantsDeps): Promise<StandingGrants> => {
    const grants = await conversationGrants.all();
    const releases = credentialGrants.all();
    const ids = new Set([...Object.keys(grants), ...releases.map((release) => release.conversationId)]);
    const conversations = [...ids].map((conversationId): StandingConversation => {
        const grant = grants[conversationId];
        return {
            conversationId,
            capabilities: [...(grant?.capabilities ?? [])],
            folders: [...(grant?.folders ?? [])],
            shelves: [...(grant?.shelves ?? [])],
            installs: grant?.installs === true,
            secrets: [...(grant?.secrets ?? [])],
            everything: grant?.everything === true,
            rules: (grant?.rules ?? []).map((pass) => ({ ...pass })),
            ...(grant?.by === undefined ? {} : { by: grant.by }),
            ...(grant === undefined ? {} : { updatedAt: grant.updatedAt }),
            releases: releases
                .filter((release) => release.conversationId === conversationId)
                .map(({ subject, grant: released }) => ({ subject, approvedBy: released.approvedBy, at: released.at })),
        };
    });
    // The most recently widened first: the one a person just allowed is the one they came to check.
    return { conversations: conversations.sort((left, right) => lastChange(right) - lastChange(left)) };
};

// Whether there was one to take back.
export const revokeGrant = async ({ conversationGrants, credentialGrants }: StandingGrantsDeps, input: GrantRevoke): Promise<boolean> => {
    if (input.kind === "release") {
        return credentialGrants.revoke(input.conversationId, input.what);
    }
    if (input.kind === "install") {
        return conversationGrants.revokeInstalls(input.conversationId);
    }
    if (input.kind === "everything") {
        return conversationGrants.revokeEverything(input.conversationId);
    }
    if (input.kind === "rule") {
        // A rule's identity is its content, which two capabilities may share: without the capability there is no telling
        // whose pass to take back, so nothing is.
        return input.capability === undefined ? false : conversationGrants.revokeRule(input.conversationId, input.capability, input.what);
    }
    return conversationGrants.revoke(input.conversationId, { subject: input.kind, what: input.what });
};

// Tells the editor's Allowed list to read again: a yes written by a card mid-turn, or a purge, moves no need, and the auth
// root it is kept under is watched by no file push. One frame for the whole list, so which conversation moved is not asked.
export const grantsChanged = (): void => {
    publishRuntimeChange("grants");
};
