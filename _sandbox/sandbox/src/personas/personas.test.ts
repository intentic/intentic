import { type Capability, type Persona, type PersonaPowers, FRONT_DESK_PERSONA, PersonaPowersSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { personaCapabilities, personaCliEnv, personaDisallowedTools, personaNote, personaPrompt, turnPersona } from "./personas.js";

const card = (id: string, capabilities: readonly string[], extra: Partial<Persona> = {}): Persona => ({
    id,
    capabilities: [...capabilities],
    ...extra,
});

// Powers as the FILE may carry them: partial, with the schema filling the rest, which is exactly what a
// hand-edited card looks like and what the resolver parses.
const powers = (partial: Record<string, unknown>): PersonaPowers => PersonaPowersSchema.parse(partial);

const browser = (id: string): Capability => ({ id, kind: "browser", config: { platform: "reddit" } });
const connector = (id: string): Capability => ({ id, kind: "cli", config: { provider: id } });
const computer = (id: string): Capability => ({
    id,
    kind: "host",
    config: {
        platform: "linux",
        shell: "on",
        write: "on",
        screen: "off",
        control: "off",
        sandboxes: "off",
        sandboxRemove: "off",
        destructive: "off",
    },
});
const mcp = (id: string): Capability => ({ id, kind: "mcp", config: { url: "https://a/mcp" } });

const CAST = [card("work", ["reddit-work", "x-work"]), card("personal", ["reddit-personal"])];

// The suffix scheme cli-env.ts uses, restated for the test rather than imported, so a change to it fails HERE
// as well as there: this is the rule that decides whether a token stays in an unrelated persona's shell.
const suffix = (id: string): string => id.toUpperCase().replaceAll("-", "_");

// ── Accounts: the half that predates the shelves ────────────────────────────────────────────────────────────

// The permissive half of the rule: a person is at the composer, so nothing is taken away.
test("an attended turn that names no persona keeps every account", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: false });
    expect(persona.reason).toBe("attended-open");
    expect(persona.allows(browser("reddit-work"))).toBe(true);
    expect(persona.allows(browser("reddit-personal"))).toBe(true);
    // Even an account no card mentions: "everything" means the manifest, not the persona list.
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

/* An identity is MORE credential than any single account: its browser holds the email session and every
 * account born from it, so it rides the account rules exactly: named on the card to be granted, and the first
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
    // Both execution backends: the JS backend defaults open like every other shelf.
    expect(persona.powers.code).toBe(true);
    expect(personaDisallowedTools(persona, [])).toEqual([]);
    // Connectors, computers and MCP connections all pass, because "absent" means "every one of them".
    expect(persona.allows(connector("github"))).toBe(true);
    expect(persona.allows(computer("laptop"))).toBe(true);
    expect(persona.allows(mcp("linear"))).toBe(true);
});

/* Naming a card that isn't there must FAIL CLOSED: on BOTH halves, and the tools half is the one with teeth.
 * A Front Desk pinned to a read-only card would otherwise regain a shell the moment somebody deleted that card,
 * with anonymous visitors driving it. A missing card is ordinary (a workspace cloned before its personas were
 * committed, a card renamed on one side only), not a corruption, so this is a state to fail loudly in. */
test("naming a persona no card carries denies everything: accounts and tools alike", () => {
    const persona = turnPersona({ personas: CAST, actsAs: "studio", unattended: false });
    expect(persona.reason).toBe("unknown-persona");
    expect(persona.persona).toBeUndefined();
    expect(persona.allows(browser("reddit-work"))).toBe(false);
    expect(persona.allows(connector("github"))).toBe(false);
    expect(persona.powers.shell).toBe(false);
    // Both execution backends fail closed: the JS backend is then never mounted (turn-plan reads this field).
    expect(persona.powers.code).toBe(false);
    expect(personaDisallowedTools(persona, [])).toContain("Bash");
    expect(personaDisallowedTools(persona, [])).toContain("Read");
});

test("a card's shelves become the tools taken out of the turn", () => {
    const persona = turnPersona({
        personas: [
            card("reader", [], { powers: powers({ files: "read", shell: false, web: false, browser: false, delegate: false, sandbox: false }) }),
        ],
        actsAs: "reader",
        unattended: true,
    });
    const denied = personaDisallowedTools(persona, []);
    // Reading survives; changing, running, fetching and delegating do not.
    expect(denied).not.toContain("Read");
    expect(denied).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", "WebFetch", "Agent"]));
});

test("files: none takes the reading tools away too", () => {
    const persona = turnPersona({ personas: [card("blind", [], { powers: powers({ files: "none" }) })], actsAs: "blind", unattended: true });
    expect(personaDisallowedTools(persona, [])).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Edit", "Write"]));
});

// ── The skill of a capability this turn cannot reach ────────────────────────────────────────────────────────

/* Skill files are written once per workspace, so a turn discovers every account's instructions whether or not
 * it may use that account. An unattended publish turn read the Reddit skill, went after tools that were never
 * mounted for it, found none, and reported the ACCOUNT as disconnected: failing two approved posts over a
 * login that was connected the whole time. The instructions have to go with the tools. */
test("an unattended wake loses the skills of the accounts it lost", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: true });
    const denied = personaDisallowedTools(persona, [browser("reddit-work"), connector("github")]);
    expect(denied).toContain("Skill(reddit-work)");
    // The connector survives: an unpinned wake keeps everything that is not an account, so its cheatsheet is
    // still usable and hiding it would take away a working tool.
    expect(denied).not.toContain("Skill(github)");
});

test("a card keeps its own accounts' skills and loses everyone else's", () => {
    const persona = turnPersona({ personas: CAST, actsAs: "work", unattended: true });
    const denied = personaDisallowedTools(persona, [browser("reddit-work"), browser("reddit-personal"), browser("npmjs")]);
    expect(denied).not.toContain("Skill(reddit-work)");
    // Both of these: one belongs to another card, one to no card at all. Same answer, this turn cannot post
    // from either, so it should not be reading how.
    expect(denied).toEqual(expect.arrayContaining(["Skill(reddit-personal)", "Skill(npmjs)"]));
});

test("every denied kind loses its skill, not just accounts", () => {
    // A cheatsheet whose credential was stripped from the shell, and a computer whose server was never
    // mounted, are unusable in exactly the way an account's browser is.
    const persona = turnPersona({
        personas: [card("narrow", ["github"], { powers: powers({ connectors: ["github"], computers: [], mcp: [] }) })],
        actsAs: "narrow",
        unattended: true,
    });
    const denied = personaDisallowedTools(persona, [connector("github"), connector("linear"), computer("laptop"), mcp("notion")]);
    expect(denied).not.toContain("Skill(github)");
    expect(denied).toEqual(expect.arrayContaining(["Skill(linear)", "Skill(laptop)", "Skill(notion)"]));
});

// ── The manifest, narrowed once ─────────────────────────────────────────────────────────────────────────────

/* Kinds the card has no opinion about pass straight through. Narrowing those would break unrelated work every
 * time a turn wore a persona, and (worse) would silently deny a capability kind added tomorrow. */
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
 * an instruction not to look, which is the difference between this being a fence and being advice. */
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

// The environment carries more than connector credentials: the PATH that makes extension CLIs resolve, an
// extension's own settings, so a card granting everything must hand it back untouched rather than rebuilt.
test("a card that grants every connector leaves the environment exactly as it was", () => {
    const cliEnv = { GITHUB_TOKEN_GITHUB: "gh-secret", PATH: "/usr/bin" };
    const persona = turnPersona({ personas: CAST, actsAs: "work", unattended: true });
    expect(personaCliEnv(cliEnv, [connector("github")], persona, suffix)).toBe(cliEnv);
});

// ── What the turn is told ───────────────────────────────────────────────────────────────────────────────────

test("the note names the persona and says its accounts are the only ones", () => {
    const note = personaNote(
        turnPersona({
            personas: [card("work", ["reddit-work"], { label: "Work Reddit" })],
            actsAs: "work",
            unattended: true,
        }),
    );
    expect(note).toContain("Work Reddit");
    expect(note).toContain("Only that persona's accounts");
});

/* The one card whose wording is the PRODUCT's (a public web chat's desk) gets it from the daemon rather than
 * from a field on the card, so this is what proves the guidance still reaches the turn that needs it. */
test("the front desk's own manner rides its note, and no other card's", () => {
    const desk = personaNote(turnPersona({ personas: [card(FRONT_DESK_PERSONA, [])], actsAs: FRONT_DESK_PERSONA, unattended: true }));
    expect(desk).toContain("You are the front desk");
    expect(personaNote(turnPersona({ personas: CAST, actsAs: "work", unattended: true }))).not.toContain("front desk");
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

// ── The prompt: the fourth question the card answers ─────────────────────────────────────────────────────────

/* THE SANDBOX'S ANSWER IS THE DEFAULT, and stays the answer for every card written before the field existed:
 * which on a real workspace is all of them. The field is absent rather than spelling "inherit", so this is also
 * the case that proves an untouched card changes nothing. */
const SETTINGS = { systemPromptMode: "intentic", systemPrompt: "" } as const;

test("a card that says nothing about the prompt runs on the sandbox's", () => {
    expect(personaPrompt(card("work", []), undefined, SETTINGS)).toEqual({ mode: "intentic", systemPrompt: "" });
    // And so does a turn wearing no card at all.
    expect(personaPrompt(undefined, undefined, { systemPromptMode: "custom", systemPrompt: "Sandbox text." })).toEqual({
        mode: "custom",
        systemPrompt: "Sandbox text.",
    });
});

test("a card with its own prompt replaces the sandbox's, text and all", () => {
    const desk = card("desk", [], { systemPromptMode: "custom" });
    expect(personaPrompt(desk, "You are a release-notes writer.", { systemPromptMode: "intentic", systemPrompt: "" })).toEqual({
        mode: "custom",
        systemPrompt: "You are a release-notes writer.",
    });
});

/* A CARD PINNED TO A BUILT-IN BASE CARRIES NO TEXT, and must not inherit the sandbox's: a persona set to
 * "claude" while the sandbox is on a custom prompt would otherwise run Claude's preset with the owner's
 * unrelated replacement still sitting in the field the composer reads under "custom". */
test("a card on a built-in base takes the base and none of the sandbox's text", () => {
    expect(
        personaPrompt(card("work", [], { systemPromptMode: "claude" }), undefined, { systemPromptMode: "custom", systemPrompt: "Sandbox." }),
    ).toEqual({ mode: "claude", systemPrompt: "" });
});

/* HALF-MADE IS NOT EMPTY. Picking "custom" and not yet writing anything is somebody mid-edit, and running that
 * turn on a blank system prompt would be obeying a decision nobody finished making. */
test("custom with nothing written yet falls back to the sandbox", () => {
    expect(personaPrompt(card("desk", [], { systemPromptMode: "custom" }), undefined, SETTINGS)).toEqual({ mode: "intentic", systemPrompt: "" });
});
