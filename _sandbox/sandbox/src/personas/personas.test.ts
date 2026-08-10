import { type Capability, type Persona, type PersonaPowers, PersonaPowersSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { personaCapabilities, personaCliEnv, personaDisallowedTools, personaNote, turnPersona } from "./personas.js";

const card = (id: string, capabilities: readonly string[], extra: Partial<Persona> = {}): Persona => ({
    id,
    capabilities: [...capabilities],
    ...extra,
});

// Powers as the FILE may carry them — partial, with the schema filling the rest, which is exactly what a
// hand-edited card looks like and what the resolver parses.
const powers = (partial: Record<string, unknown>): PersonaPowers => PersonaPowersSchema.parse(partial);

const browser = (id: string): Capability => ({ id, kind: "browser", config: { platform: "reddit" } });
const connector = (id: string): Capability => ({ id, kind: "cli", config: { provider: id } });
const computer = (id: string): Capability => ({
    id,
    kind: "host",
    config: { platform: "linux", shell: "on", write: "on", screen: "off", control: "off", sandboxes: "off", sandboxRemove: "off" },
});
const mcp = (id: string): Capability => ({ id, kind: "mcp", config: { url: "https://a/mcp" } });

const CAST = [card("work", ["reddit-work", "x-work"]), card("personal", ["reddit-personal"])];

// The suffix scheme cli-env.ts uses, restated for the test rather than imported, so a change to it fails HERE
// as well as there — this is the rule that decides whether a token stays in an unrelated persona's shell.
const suffix = (id: string): string => id.toUpperCase().replaceAll("-", "_");

// ── Accounts: the half that predates the shelves ────────────────────────────────────────────────────────────

// The permissive half of the rule: a person is at the composer, so nothing is taken away.
test("an attended turn that names no persona keeps every account", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: false });
    expect(persona.reason).toBe("attended-open");
    expect(persona.allows(browser("reddit-work"))).toBe(true);
    expect(persona.allows(browser("reddit-personal"))).toBe(true);
    // Even an account no card mentions — "everything" means the manifest, not the persona list.
    expect(persona.allows(browser("npmjs"))).toBe(true);
});

/* The strict half, and the whole reason this layer is in the kernel rather than in a prompt. A wake fires with
 * nobody watching; the one thing that must not happen is it reaching a logged-in account by saying nothing. */
test("an unattended wake that names no persona reaches no account at all", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: true });
    expect(persona.reason).toBe("unattended-unpinned");
    expect(persona.allows(browser("reddit-work"))).toBe(false);
    expect(persona.allows(browser("reddit-personal"))).toBe(false);
});

test("a named persona is narrowed to exactly its own accounts, attended or not", () => {
    for (const unattended of [false, true]) {
        const persona = turnPersona({ personas: CAST, actsAs: "work", unattended });
        expect(persona.reason).toBe("persona");
        expect(persona.persona?.id).toBe("work");
        expect(persona.allows(browser("reddit-work"))).toBe(true);
        expect(persona.allows(browser("x-work"))).toBe(true);
        // The other persona's account is absent even though it is connected and this turn could see it a moment ago.
        expect(persona.allows(browser("reddit-personal"))).toBe(false);
    }
});

test("a persona with an empty card allows nothing, which is not the same as naming none", () => {
    const persona = turnPersona({ personas: [card("mute", [])], actsAs: "mute", unattended: false });
    expect(persona.reason).toBe("persona");
    expect(persona.allows(browser("reddit-work"))).toBe(false);
});

/* An identity is MORE credential than any single account — its browser holds the email session and every
 * account born from it — so it rides the account rules exactly: named on the card to be granted, and the first
 * thing an unattended unpinned wake loses. A blanket pass-through here (the default arm) would hand a nightly
 * job the strongest browser in the sandbox by omission. */
test("identities count as accounts: card-named when pinned, gone entirely when an unpinned wake fires", () => {
    const identity: Capability = { id: "main", kind: "identity", config: { email: "me@gmail.com", openAccounts: "off" } };
    const cast = [card("outward", ["main", "reddit-work"])];
    expect(turnPersona({ personas: cast, actsAs: "outward", unattended: true }).allows(identity)).toBe(true);
    // A card that names only accounts born from it does NOT get the identity itself.
    expect(turnPersona({ personas: [card("narrow", ["reddit-work"])], actsAs: "narrow", unattended: false }).allows(identity)).toBe(false);
    expect(turnPersona({ personas: cast, actsAs: undefined, unattended: true }).allows(identity)).toBe(false);
    expect(turnPersona({ personas: cast, actsAs: undefined, unattended: false }).allows(identity)).toBe(true);
});

// ── Powers: permissive by default, and the one case where that flips ────────────────────────────────────────

/* The decision this whole layer rests on, stated as a test because it is the one an owner would notice being
 * broken: an automation that has never heard of personas keeps working exactly as it did. Defaulting powers to
 * nothing would have been a migration dressed as a security default. */
test("an unpinned wake keeps the full toolbox even though it has lost every account", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: true });
    expect(persona.powers.files).toBe("write");
    expect(persona.powers.shell).toBe(true);
    expect(personaDisallowedTools(persona)).toEqual([]);
    // Connectors, computers and MCP connections all pass, because "absent" means "every one of them".
    expect(persona.allows(connector("github"))).toBe(true);
    expect(persona.allows(computer("laptop"))).toBe(true);
    expect(persona.allows(mcp("linear"))).toBe(true);
});

/* Naming a card that isn't there must FAIL CLOSED — on BOTH halves, and the tools half is the one with teeth.
 * A Doorbell pinned to a read-only card would otherwise regain a shell the moment somebody deleted that card,
 * with anonymous visitors driving it. A missing card is ordinary (a workspace cloned before its personas were
 * committed, a card renamed on one side only), not a corruption, so this is a state to fail loudly in. */
test("naming a persona no card carries denies everything — accounts and tools alike", () => {
    const persona = turnPersona({ personas: CAST, actsAs: "studio", unattended: false });
    expect(persona.reason).toBe("unknown-persona");
    expect(persona.persona).toBeUndefined();
    expect(persona.allows(browser("reddit-work"))).toBe(false);
    expect(persona.allows(connector("github"))).toBe(false);
    expect(persona.powers.shell).toBe(false);
    expect(personaDisallowedTools(persona)).toContain("Bash");
    expect(personaDisallowedTools(persona)).toContain("Read");
});

test("a card's shelves become the tools taken out of the turn", () => {
    const persona = turnPersona({
        personas: [card("reader", [], { powers: powers({ files: "read", shell: false, web: false, browser: false, delegate: false, sandbox: false }) })],
        actsAs: "reader",
        unattended: true,
    });
    const denied = personaDisallowedTools(persona);
    // Reading survives; changing, running, fetching and delegating do not.
    expect(denied).not.toContain("Read");
    expect(denied).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", "WebFetch", "Agent"]));
});

test("files: none takes the reading tools away too", () => {
    const persona = turnPersona({ personas: [card("blind", [], { powers: powers({ files: "none" }) })], actsAs: "blind", unattended: true });
    expect(personaDisallowedTools(persona)).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Edit", "Write"]));
});

// ── The manifest, narrowed once ─────────────────────────────────────────────────────────────────────────────

/* Kinds the card has no opinion about pass straight through. Narrowing those would break unrelated work every
 * time a turn wore a persona, and — worse — would silently deny a capability kind added tomorrow. */
test("a card filters accounts, connectors, computers and MCP; other kinds pass through", () => {
    const installed: Capability[] = [
        browser("reddit-work"),
        browser("reddit-personal"),
        connector("github"),
        connector("komodo"),
        computer("laptop"),
        mcp("linear"),
        { id: "pi", kind: "agent", config: { command: "pi" } },
    ];
    const persona = turnPersona({
        personas: [card("work", ["reddit-work"], { powers: powers({ connectors: ["github"], computers: [], mcp: [] }) })],
        actsAs: "work",
        unattended: true,
    });
    const visible = personaCapabilities(installed, persona);
    // The agent runtime survives: a persona that could switch off the runtime serving its own turn is a card
    // that can only confuse.
    expect(visible.map((capability) => capability.id)).toEqual(["reddit-work", "github", "pi"]);
});

test("an unpinned wake keeps its non-account capabilities while losing every logged-in account", () => {
    const installed: Capability[] = [browser("reddit-work"), mcp("linear")];
    const visible = personaCapabilities(installed, turnPersona({ personas: CAST, actsAs: undefined, unattended: true }));
    expect(visible.map((capability) => capability.id)).toEqual(["linear"]);
});

/* An ungranted connector's credentials leave the shell's environment entirely, rather than staying in it with
 * an instruction not to look — which is the difference between this being a fence and being advice. */
test("an ungranted connector's credentials are removed from the shell environment", () => {
    const installed = [connector("github"), connector("komodo")];
    const cliEnv = {
        GITHUB_TOKEN_GITHUB: "gh-secret",
        KOMODO_KEY_KOMODO: "komodo-secret",
        KOMODO_SECRET_KOMODO: "komodo-secret-2",
        PATH: "/usr/bin",
    };
    const persona = turnPersona({ personas: [card("ci", [], { powers: powers({ connectors: ["github"] }) })], actsAs: "ci", unattended: true });
    expect(personaCliEnv(cliEnv, installed, persona, suffix)).toEqual({ GITHUB_TOKEN_GITHUB: "gh-secret", PATH: "/usr/bin" });
});

// The environment carries more than connector credentials — the PATH that makes extension CLIs resolve, an
// extension's own settings — so a card granting everything must hand it back untouched rather than rebuilt.
test("a card that grants every connector leaves the environment exactly as it was", () => {
    const cliEnv = { GITHUB_TOKEN_GITHUB: "gh-secret", PATH: "/usr/bin" };
    const persona = turnPersona({ personas: CAST, actsAs: "work", unattended: true });
    expect(personaCliEnv(cliEnv, [connector("github")], persona, suffix)).toBe(cliEnv);
});

// ── What the turn is told ───────────────────────────────────────────────────────────────────────────────────

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

/* The folder limit IS narrated, unlike the shelves, and the asymmetry is deliberate: a tool that is absent
 * teaches by being absent, while a refusal on a path arrives mid-task and reads as a broken tool unless the
 * agent already knows where it is expected to work. */
test("the note names the folders the persona works in", () => {
    const note = personaNote(
        turnPersona({
            personas: [card("app", [], { workspace: { folders: ["apps/web", "packages/ui"] } })],
            actsAs: "app",
            unattended: true,
        }),
    );
    expect(note).toContain("apps/web, packages/ui");
});

// Nothing to narrate when nothing changed: an open attended turn is the status quo, and a turn with no accounts
// is better served by the tools being absent than by a paragraph about their absence.
test("no note for an open attended turn, nor for an unpinned wake", () => {
    expect(personaNote(turnPersona({ personas: CAST, actsAs: undefined, unattended: false }))).toBeUndefined();
    expect(personaNote(turnPersona({ personas: CAST, actsAs: undefined, unattended: true }))).toBeUndefined();
});
