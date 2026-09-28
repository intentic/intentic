import { memoryConversationGrants } from "../personas/conversation-grants.js";
import { createCredentialGrants } from "../secrets/credential-grants.js";
import { revokeGrant, standingGrants } from "./standing-grants.js";

// The yeses still standing, as Needs you lists them: one row per conversation, carrying both what its grants widened and
// what a named person released to it, the most recently widened first; and each one taken back alone.

const harness = () => {
    let clock = 100;
    const conversationGrants = memoryConversationGrants(() => clock);
    const credentialGrants = createCredentialGrants();
    return { deps: { conversationGrants, credentialGrants }, tick: (to: number) => (clock = to) };
};

test("a conversation's grants and its releases come back as one row, newest change first", async () => {
    const { deps, tick } = harness();
    await deps.conversationGrants.add("conv-old", { subject: "folder", what: "refs/vendor" }, "ada@acme.dev");
    tick(300);
    await deps.conversationGrants.add("conv-new", { subject: "capability", what: "github" }, "ada@acme.dev");
    await deps.conversationGrants.add("conv-new", { subject: "shelf", what: "browser" }, "bob@acme.dev");
    deps.credentialGrants.grant("conv-released", "reddit-work", { approvedBy: "bob@acme.dev", at: 200 });

    expect(await standingGrants(deps)).toEqual({
        conversations: [
            { conversationId: "conv-new", capabilities: ["github"], folders: [], shelves: ["browser"], by: "bob@acme.dev", updatedAt: 300, releases: [] },
            { conversationId: "conv-released", capabilities: [], folders: [], shelves: [], releases: [{ subject: "reddit-work", approvedBy: "bob@acme.dev", at: 200 }] },
            { conversationId: "conv-old", capabilities: [], folders: ["refs/vendor"], shelves: [], by: "ada@acme.dev", updatedAt: 100, releases: [] },
        ],
    });
});

test("taking one back leaves the rest, and a conversation with nothing left drops out", async () => {
    const { deps } = harness();
    await deps.conversationGrants.add("conv-1", { subject: "capability", what: "github" }, "ada@acme.dev");
    await deps.conversationGrants.add("conv-1", { subject: "folder", what: "docs" }, "ada@acme.dev");
    deps.credentialGrants.grant("conv-2", "reddit-work", { approvedBy: "bob@acme.dev", at: 5 });

    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "capability", what: "github" })).toBe(true);
    expect(await revokeGrant(deps, { conversationId: "conv-2", kind: "release", what: "reddit-work" })).toBe(true);
    // Nothing of that name to take back: said, not pretended.
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "shelf", what: "browser" })).toBe(false);
    expect(await revokeGrant(deps, { conversationId: "conv-2", kind: "release", what: "reddit-work" })).toBe(false);

    expect((await standingGrants(deps)).conversations).toEqual([
        { conversationId: "conv-1", capabilities: [], folders: ["docs"], shelves: [], by: "ada@acme.dev", updatedAt: 100, releases: [] },
    ]);
    expect(deps.credentialGrants.has("conv-2", "reddit-work")).toBeUndefined();
});
