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
            { conversationId: "conv-new", capabilities: ["github"], folders: [], shelves: ["browser"], installs: false, secrets: [], everything: false, by: "bob@acme.dev", updatedAt: 300, releases: [] },
            {
                conversationId: "conv-released",
                capabilities: [],
                folders: [],
                shelves: [],
                installs: false,
                secrets: [],
                everything: false,
                releases: [{ subject: "reddit-work", approvedBy: "bob@acme.dev", at: 200 }],
            },
            { conversationId: "conv-old", capabilities: [], folders: ["refs/vendor"], shelves: [], installs: false, secrets: [], everything: false, by: "ada@acme.dev", updatedAt: 100, releases: [] },
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
        { conversationId: "conv-1", capabilities: [], folders: ["docs"], shelves: [], installs: false, secrets: [], everything: false, by: "ada@acme.dev", updatedAt: 100, releases: [] },
    ]);
    expect(deps.credentialGrants.has("conv-2", "reddit-work")).toBeUndefined();
});

// An install card's "Allow installs for this conversation" is a yes like any other: listed, and taken back alone.
test("a conversation's unasked installs are listed with its other yeses and taken back on their own", async () => {
    const { deps, tick } = harness();
    await deps.conversationGrants.add("conv-1", { subject: "folder", what: "docs" }, "ada@acme.dev");
    tick(200);
    await deps.conversationGrants.allowInstalls("conv-1", undefined);
    expect(await deps.conversationGrants.installsAllowed("conv-1")).toBe(true);
    expect((await standingGrants(deps)).conversations).toEqual([
        { conversationId: "conv-1", capabilities: [], folders: ["docs"], shelves: [], installs: true, secrets: [], everything: false, by: "ada@acme.dev", updatedAt: 200, releases: [] },
    ]);

    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "install", what: "" })).toBe(true);
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "install", what: "" })).toBe(false);
    expect(await deps.conversationGrants.installsAllowed("conv-1")).toBe(false);
    // The folder stands; only the installs yes went.
    expect((await standingGrants(deps)).conversations).toEqual([
        { conversationId: "conv-1", capabilities: [], folders: ["docs"], shelves: [], installs: false, secrets: [], everything: false, by: "ada@acme.dev", updatedAt: 200, releases: [] },
    ]);
});

test("a conversation whose only yes was its installs drops out once that is taken back", async () => {
    const { deps } = harness();
    await deps.conversationGrants.allowInstalls("conv-1", "ada@acme.dev");
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "install", what: "" })).toBe(true);
    expect((await standingGrants(deps)).conversations).toEqual([]);
});

// A permission card's "Allow everything in this conversation" and a host guard card's "Allow <secret> anywhere in this
// conversation": listed with the rest, each taken back alone, and a conversation left with neither drops out.
test("everything and a secret's pass are listed and taken back on their own", async () => {
    const { deps } = harness();
    await deps.conversationGrants.allowEverything("conv-1", "ada@acme.dev");
    await deps.conversationGrants.add("conv-1", { subject: "secret", what: "github/token" }, "ada@acme.dev");
    expect(await deps.conversationGrants.everythingAllowed("conv-1")).toBe(true);
    expect((await standingGrants(deps)).conversations).toEqual([
        {
            conversationId: "conv-1",
            capabilities: [],
            folders: [],
            shelves: [],
            installs: false,
            secrets: ["github/token"],
            everything: true,
            by: "ada@acme.dev",
            updatedAt: 100,
            releases: [],
        },
    ]);

    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "everything", what: "" })).toBe(true);
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "everything", what: "" })).toBe(false);
    expect(await deps.conversationGrants.everythingAllowed("conv-1")).toBe(false);
    expect((await standingGrants(deps)).conversations).toMatchObject([{ conversationId: "conv-1", secrets: ["github/token"], everything: false }]);

    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "secret", what: "github/token" })).toBe(true);
    expect((await standingGrants(deps)).conversations).toEqual([]);
});
