import type { Capability, Persona } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { personaCapabilities, personaNote, turnPersona } from "./personas.js";

const card = (id: string, capabilities: readonly string[], extra: Partial<Persona> = {}): Persona => ({
    id,
    capabilities: [...capabilities],
    ...extra,
});

const browser = (id: string): Capability => ({ id, kind: "browser", config: { platform: "reddit" } });

const CAST = [card("work", ["reddit-work", "x-work"]), card("personal", ["reddit-personal"])];

// The permissive half of the rule: a person is at the composer, so nothing is taken away.
test("an attended turn that names no persona keeps every account", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: false });
    expect(persona.reason).toBe("attended-open");
    expect(persona.allows("reddit-work")).toBe(true);
    expect(persona.allows("reddit-personal")).toBe(true);
    // Even an account no card mentions — "everything" means the manifest, not the persona list.
    expect(persona.allows("npmjs")).toBe(true);
});

/* The strict half, and the whole reason this layer is in the kernel rather than in a prompt. A wake fires with
 * nobody watching; the one thing that must not happen is it reaching a logged-in account by saying nothing. */
test("an unattended wake that names no persona reaches no account at all", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: true });
    expect(persona.reason).toBe("unattended-unpinned");
    expect(persona.allows("reddit-work")).toBe(false);
    expect(persona.allows("reddit-personal")).toBe(false);
});

test("a named persona is narrowed to exactly its own accounts, attended or not", () => {
    for (const unattended of [false, true]) {
        const persona = turnPersona({ personas: CAST, actsAs: "work", unattended });
        expect(persona.reason).toBe("persona");
        expect(persona.persona?.id).toBe("work");
        expect(persona.allows("reddit-work")).toBe(true);
        expect(persona.allows("x-work")).toBe(true);
        // The other persona's account is absent even though it is connected and this turn could see it a moment ago.
        expect(persona.allows("reddit-personal")).toBe(false);
    }
});

/* Naming a card that isn't there must FAIL CLOSED. Falling back to "every account" would invert the owner's
 * request into the exact accident the layer exists to prevent — and a missing card is ordinary (a workspace
 * cloned before its personas were committed, a card renamed on one side only), not a corruption. */
test("naming a persona no card carries denies everything rather than falling back to all", () => {
    const persona = turnPersona({ personas: CAST, actsAs: "studio", unattended: false });
    expect(persona.reason).toBe("unknown-persona");
    expect(persona.persona).toBeUndefined();
    expect(persona.allows("reddit-work")).toBe(false);
});

test("a persona with an empty card allows nothing, which is not the same as naming none", () => {
    const persona = turnPersona({ personas: [card("mute", [])], actsAs: "mute", unattended: false });
    expect(persona.reason).toBe("persona");
    expect(persona.allows("reddit-work")).toBe(false);
});

/* Only the outward personas are filtered. The rest of the manifest is the sandbox's own machinery — an MCP server,
 * a database URL — and narrowing those would break unrelated work every time a turn wore a persona. */
test("only browser capabilities are filtered; the rest of the manifest passes through", () => {
    const installed: Capability[] = [
        browser("reddit-work"),
        browser("reddit-personal"),
        { id: "linear", kind: "mcp", config: { url: "https://a/mcp" } },
    ];
    const visible = personaCapabilities(installed, turnPersona({ personas: CAST, actsAs: "work", unattended: true }));
    expect(visible.map((capability) => capability.id)).toEqual(["reddit-work", "linear"]);
});

test("an unpinned wake keeps its non-browser capabilities while losing every logged-in account", () => {
    const installed: Capability[] = [browser("reddit-work"), { id: "linear", kind: "mcp", config: { url: "https://a/mcp" } }];
    const visible = personaCapabilities(installed, turnPersona({ personas: CAST, actsAs: undefined, unattended: true }));
    expect(visible.map((capability) => capability.id)).toEqual(["linear"]);
});

test("the note names the persona, carries its voice, and says when it may not publish", () => {
    const note = personaNote(
        turnPersona({
            personas: [card("work", ["reddit-work"], { label: "Work Reddit", voice: "Dry, no exclamation marks.", posture: "draft" })],
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
    expect(personaNote(turnPersona({ personas: CAST, actsAs: undefined, unattended: false }))).toBeUndefined();
    expect(personaNote(turnPersona({ personas: CAST, actsAs: undefined, unattended: true }))).toBeUndefined();
});
