import { memoryConversationGrants } from "../personas/conversation-grants.js";
import { memoryOwnerGrants } from "../personas/owner-grants.js";
import { createCredentialGrants } from "../secrets/credential-grants.js";
import { notifyingCredentialGrants } from "../secrets/secrets-slice.js";
import { type OwnerApprovals, revokeGrant, standingGrants } from "./standing-grants.js";
import { standingDeps } from "./standing-grants.testing.js";

// The yeses still standing, as Needs you lists them: one row per conversation, carrying both what its grants widened and
// what a named person released to it, the most recently widened first; and each one taken back alone.

const harness = () => {
    let clock = 100;
    const conversationGrants = memoryConversationGrants(() => clock);
    const credentialGrants = createCredentialGrants();
    return { deps: standingDeps({ conversationGrants, credentialGrants }), tick: (to: number) => (clock = to) };
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
            { conversationId: "conv-new", capabilities: ["github"], folders: [], shelves: ["browser"], installs: false, secrets: [], everything: false, rules: [], by: "bob@acme.dev", updatedAt: 300, releases: [] },
            {
                conversationId: "conv-released",
                capabilities: [],
                folders: [],
                shelves: [],
                installs: false,
                secrets: [],
                everything: false,
                rules: [],
                releases: [{ subject: "reddit-work", approvedBy: "bob@acme.dev", at: 200 }],
            },
            { conversationId: "conv-old", capabilities: [], folders: ["refs/vendor"], shelves: [], installs: false, secrets: [], everything: false, rules: [], by: "ada@acme.dev", updatedAt: 100, releases: [] },
        ],
        ownerWide: [],
        unreadable: [],
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
        { conversationId: "conv-1", capabilities: [], folders: ["docs"], shelves: [], installs: false, secrets: [], everything: false, rules: [], by: "ada@acme.dev", updatedAt: 100, releases: [] },
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
        { conversationId: "conv-1", capabilities: [], folders: ["docs"], shelves: [], installs: true, secrets: [], everything: false, rules: [], by: "ada@acme.dev", updatedAt: 200, releases: [] },
    ]);

    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "install", what: "" })).toBe(true);
    expect(await revokeGrant(deps, { conversationId: "conv-1", kind: "install", what: "" })).toBe(false);
    expect(await deps.conversationGrants.installsAllowed("conv-1")).toBe(false);
    // The folder stands; only the installs yes went.
    expect((await standingGrants(deps)).conversations).toEqual([
        { conversationId: "conv-1", capabilities: [], folders: ["docs"], shelves: [], installs: false, secrets: [], everything: false, rules: [], by: "ada@acme.dev", updatedAt: 200, releases: [] },
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
            rules: [],
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

// Releases are announced by wrapping their store, so the Allowed list moves when one is made, taken back or forgotten;
// a take-back or a forgetting that found nothing is no news.
test("a release, its take-back and its conversation's forgetting are each announced once", () => {
    const heard: string[] = [];
    const releases = notifyingCredentialGrants(createCredentialGrants(), (conversationId) => heard.push(conversationId));
    releases.grant("conv-1", "github", { approvedBy: "ada@acme.dev", at: 1 });
    releases.grant("conv-2", "linear", { approvedBy: "ada@acme.dev", at: 2 });
    expect(releases.revoke("conv-1", "github")).toBe(true);
    expect(releases.revoke("conv-1", "github")).toBe(false);
    releases.forget("conv-2");
    releases.forget("conv-2");
    expect(heard).toEqual(["conv-1", "conv-2", "conv-1", "conv-2"]);
    expect(releases.all()).toEqual([]);
});

// The yeses that name no conversation, beside the per-conversation ones: a command policy line allowed with Always, a hook
// set the owner approved by its digest, and a workspace extension they approved for its powers. One list, newest first,
// and one door that takes any of them back.
const HOOK = { source: "project", event: "PreToolUse", matcher: "Bash", type: "command", run: "./scripts/audit.sh" } as const;

const ownerWideHarness = () => {
    const base = harness();
    const ownerGrants = memoryOwnerGrants(() => 300);
    const hookSets = new Map([["a".repeat(64), { approvedAt: 200, hooks: [HOOK, { ...HOOK, event: "Stop", matcher: undefined, run: "notify" }] }]]);
    const extensions = new Map([["acme.stripe", { powers: ["Run a process at start", "Call api.stripe.com"], approvedAt: 400 }]]);
    const approvals: OwnerApprovals = {
        hookSets: async () => ({ sets: [...hookSets].map(([digest, set]) => ({ digest, ...set })), unreadable: false }),
        revokeHookSet: async (digest) => hookSets.delete(digest),
        extensions: async () => ({ extensions: [...extensions].map(([id, extension]) => ({ id, ...extension })), unreadable: false }),
        revokeExtension: async (id) => extensions.delete(id),
    };
    return { ...base, ownerGrants, deps: standingDeps({ ...base.deps, ownerGrants, approvals }), hookSets, extensions };
};

test("owner-wide yeses are listed newest first, each in words a person can read", async () => {
    const { deps, ownerGrants } = ownerWideHarness();
    await ownerGrants.allowCommandPolicy("Deleting build directories under /work is fine.", "ada@acme.dev");

    expect((await standingGrants(deps)).ownerWide).toEqual([
        { kind: "extension", id: "acme.stripe", powers: ["Run a process at start", "Call api.stripe.com"], at: 400 },
        { kind: "command-policy", line: "Deleting build directories under /work is fine.", at: 300, by: "ada@acme.dev" },
        { kind: "hook-set", digest: "a".repeat(64), hooks: ["PreToolUse (Bash): ./scripts/audit.sh", "Stop: notify"], at: 200 },
    ]);
});

test("each owner-wide yes is taken back alone, by its own name, and a second time finds nothing", async () => {
    const { deps, ownerGrants, hookSets, extensions } = ownerWideHarness();
    await ownerGrants.allowCommandPolicy("First.", undefined);
    await ownerGrants.allowCommandPolicy("Second.", undefined);

    expect(await revokeGrant(deps, { kind: "command-policy", what: "First." })).toBe(true);
    expect(await revokeGrant(deps, { kind: "command-policy", what: "First." })).toBe(false);
    expect((await ownerGrants.read()).commandPolicy.map((grant) => grant.line)).toEqual(["Second."]);

    expect(await revokeGrant(deps, { kind: "hook-set", what: "b".repeat(64) })).toBe(false);
    expect(await revokeGrant(deps, { kind: "hook-set", what: "a".repeat(64) })).toBe(true);
    expect(hookSets.size).toBe(0);

    expect(await revokeGrant(deps, { kind: "extension", what: "acme.stripe" })).toBe(true);
    expect(await revokeGrant(deps, { kind: "extension", what: "acme.stripe" })).toBe(false);
    expect(extensions.size).toBe(0);
    expect((await standingGrants(deps)).ownerWide).toEqual([{ kind: "command-policy", line: "Second.", at: 300 }]);
});

// The same kinds never reach a conversation's grants: a conversation of that name keeps what it holds.
test("an owner-wide take-back touches no conversation's grants", async () => {
    const { deps } = ownerWideHarness();
    await deps.conversationGrants.add("conv-1", { subject: "folder", what: "docs" }, "ada@acme.dev");
    await revokeGrant(deps, { kind: "extension", what: "acme.stripe" });
    expect((await standingGrants(deps)).conversations).toMatchObject([{ conversationId: "conv-1", folders: ["docs"] }]);
});

test("a record this build cannot read is named, and what it would have listed is not", async () => {
    const { deps } = ownerWideHarness();
    const approvals: OwnerApprovals = {
        ...deps.approvals,
        hookSets: async () => ({ sets: [], unreadable: true }),
        extensions: async () => ({ extensions: [], unreadable: true }),
    };
    const ownerGrants = { ...deps.ownerGrants, read: async () => ({ commandPolicy: [], unreadable: true }) };
    expect(await standingGrants({ ...deps, approvals, ownerGrants })).toMatchObject({ ownerWide: [], unreadable: ["command-policy", "hook-set", "extension"] });
});
