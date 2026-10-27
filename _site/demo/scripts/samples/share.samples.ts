import type { GroupSamples } from "./context.ts";

// The recording's own share is refreshed and taken down; the new one stays, its id being minted fresh.
export const shareSamples: GroupSamples<`share`> = ({ fleet }) => ({
    list: undefined,
    create: { conversationId: fleet.REVIEW_AGENT_ID, title: `Smoke share`, detail: `messages` },
    update: { id: `soft-deletes-for-users-3fa9c1d2` },
    remove: { id: `soft-deletes-for-users-3fa9c1d2` },
});
