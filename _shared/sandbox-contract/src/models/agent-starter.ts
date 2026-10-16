// Who started a conversation when it was not a person, read off the summary's `startedBy` (the daemon's
// auth/principal.ts writes these prefixes). Moved here from the editor's ownership.ts (2026-10-16), which re-exports it,
// because which card a child agent rides under (models/agent-lanes.ts) is the daemon's count too.

// A starter that is not a person: a program holding a control token, or the conversation that spawned this one.
export type StarterLook = { readonly kind: "token"; readonly label: string } | { readonly kind: "child"; readonly parent: string };

const TOKEN_PREFIX = "token:";
const CHILD_PREFIX = "agent:";

export const starterLook = (startedBy: string | undefined): StarterLook | undefined => {
    if (startedBy?.startsWith(TOKEN_PREFIX) === true) {
        return { kind: "token", label: startedBy.slice(TOKEN_PREFIX.length) };
    }
    if (startedBy?.startsWith(CHILD_PREFIX) === true) {
        return { kind: "child", parent: startedBy.slice(CHILD_PREFIX.length) };
    }
    return undefined;
};

// The conversation that spawned this one, when one did. A fact apart from whose it is: a child inherits its parent's
// owner, so on the reader's own work an ownership mark would never get to say it.
export const parentOf = (startedBy: string | undefined): string | undefined => {
    const look = starterLook(startedBy);
    return look?.kind === "child" ? look.parent : undefined;
};
