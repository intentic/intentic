import type { Capability, Identity } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { identityCapabilities, identityNote, turnIdentity } from "./identities.js";

const card = (id: string, capabilities: readonly string[], extra: Partial<Identity> = {}): Identity => ({
    id,
    capabilities: [...capabilities],
    ...extra,
});

const browser = (id: string): Capability => ({ id, kind: "browser", config: { platform: "reddit" } });

const CAST = [card("work", ["reddit-work", "x-work"]), card("personal", ["reddit-personal"])];

// The permissive half of the rule: a person is at the composer, so nothing is taken away.
test("an attended turn that names no identity keeps every account", () => {
    const identity = turnIdentity({ identities: CAST, actsAs: undefined, unattended: false });
    expect(identity.reason).toBe("attended-open");
    expect(identity.allows("reddit-work")).toBe(true);
    expect(identity.allows("reddit-personal")).toBe(true);
    // Even an account no card mentions — "everything" means the manifest, not the cast.
    expect(identity.allows("npmjs")).toBe(true);
});

/* The strict half, and the whole reason this layer is in the kernel rather than in a prompt. A wake fires with
 * nobody watching; the one thing that must not happen is it reaching a logged-in account by saying nothing. */
test("an unattended wake that names no identity reaches no account at all", () => {
    const identity = turnIdentity({ identities: CAST, actsAs: undefined, unattended: true });
    expect(identity.reason).toBe("unattended-unpinned");
    expect(identity.allows("reddit-work")).toBe(false);
    expect(identity.allows("reddit-personal")).toBe(false);
});

test("a named identity is narrowed to exactly its own accounts, attended or not", () => {
    for (const unattended of [false, true]) {
        const identity = turnIdentity({ identities: CAST, actsAs: "work", unattended });
        expect(identity.reason).toBe("identity");
        expect(identity.identity?.id).toBe("work");
        expect(identity.allows("reddit-work")).toBe(true);
        expect(identity.allows("x-work")).toBe(true);
        // The other face's account is absent even though it is connected and this turn could see it a moment ago.
        expect(identity.allows("reddit-personal")).toBe(false);
    }
});

/* Naming a card that isn't there must FAIL CLOSED. Falling back to "every account" would invert the owner's
 * request into the exact accident the layer exists to prevent — and a missing card is ordinary (a workspace
 * cloned before its identities were committed, a card renamed on one side only), not a corruption. */
test("naming an identity no card carries denies everything rather than falling back to all", () => {
    const identity = turnIdentity({ identities: CAST, actsAs: "studio", unattended: false });
    expect(identity.reason).toBe("unknown-identity");
    expect(identity.identity).toBeUndefined();
    expect(identity.allows("reddit-work")).toBe(false);
});

test("an identity with an empty card allows nothing, which is not the same as naming none", () => {
    const identity = turnIdentity({ identities: [card("mute", [])], actsAs: "mute", unattended: false });
    expect(identity.reason).toBe("identity");
    expect(identity.allows("reddit-work")).toBe(false);
});

/* Only the outward faces are filtered. The rest of the manifest is the sandbox's own machinery — an MCP server,
 * a database URL — and narrowing those would break unrelated work every time a turn wore a face. */
test("only browser capabilities are filtered; the rest of the manifest passes through", () => {
    const installed: Capability[] = [
        browser("reddit-work"),
        browser("reddit-personal"),
        { id: "linear", kind: "mcp", config: { url: "https://a/mcp" } },
    ];
    const visible = identityCapabilities(installed, turnIdentity({ identities: CAST, actsAs: "work", unattended: true }));
    expect(visible.map((capability) => capability.id)).toEqual(["reddit-work", "linear"]);
});

test("an unpinned wake keeps its non-browser capabilities while losing every logged-in account", () => {
    const installed: Capability[] = [browser("reddit-work"), { id: "linear", kind: "mcp", config: { url: "https://a/mcp" } }];
    const visible = identityCapabilities(installed, turnIdentity({ identities: CAST, actsAs: undefined, unattended: true }));
    expect(visible.map((capability) => capability.id)).toEqual(["linear"]);
});

test("the note names the face, carries its voice, and says when it may not publish", () => {
    const note = identityNote(
        turnIdentity({
            identities: [card("work", ["reddit-work"], { label: "Work Reddit", voice: "Dry, no exclamation marks.", posture: "draft" })],
            actsAs: "work",
            unattended: true,
        }),
    );
    expect(note).toContain("Work Reddit");
    expect(note).toContain("Dry, no exclamation marks.");
    expect(note).toContain("does NOT publish directly");
});

// Nothing to narrate when nothing changed: an open attended turn is the status quo, and a turn with no accounts
// is better served by the tools being absent than by a paragraph about their absence.
test("no note for an open attended turn, nor for an unpinned wake", () => {
    expect(identityNote(turnIdentity({ identities: CAST, actsAs: undefined, unattended: false }))).toBeUndefined();
    expect(identityNote(turnIdentity({ identities: CAST, actsAs: undefined, unattended: true }))).toBeUndefined();
});
