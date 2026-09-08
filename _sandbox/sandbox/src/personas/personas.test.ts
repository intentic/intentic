import { type Capability, type Persona, type PersonaPowers, FRONT_DESK_PERSONA, PersonaPowersSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { personaCapabilities, personaCliEnv, personaDisallowedTools, personaNote, personaPrompt, turnPersona } from "./personas.js";

const card = (id: string, capabilities: readonly string[], extra: Partial<Persona> = {}): Persona => ({
    id,
    capabilities: [...capabilities],
    ...extra,
});

// Powers as the file may carry them: partial, with the schema filling the rest.
const powers = (partial: Record<string, unknown>): PersonaPowers => PersonaPowersSchema.parse(partial);

const browser = (id: string): Capability => ({ id, kind: "browser", config: { platform: "reddit" } });
const connector = (id: string): Capability => ({ id, kind: "cli", config: { provider: id } });
const device = (id: string): Capability => ({
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

// Suffix scheme cli-env.ts uses, restated rather than imported so a drift there fails here too.
const suffix = (id: string): string => id.toUpperCase().replaceAll("-", "_");

// Accounts: the half that predates the shelves

test("an attended turn that names no persona keeps every account", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: false });
    expect(persona.reason).toBe("attended-open");
    expect(persona.allows(browser("reddit-work"))).toBe(true);
    expect(persona.allows(browser("reddit-personal"))).toBe(true);
    // "Everything" means the whole manifest, even an account no persona names.
    expect(persona.allows(browser("npmjs"))).toBe(true);
});

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
        expect(persona.allows(browser("reddit-personal"))).toBe(false);
    }
});

test("a persona with an empty card allows nothing, which is not the same as naming none", () => {
    const persona = turnPersona({ personas: [card("mute", [])], actsAs: "mute", unattended: false });
    expect(persona.reason).toBe("persona");
    expect(persona.allows(browser("reddit-work"))).toBe(false);
});

// An identity is more credential than any account: it follows the same rule, named to be granted, first thing an
// unpinned wake loses. A blanket pass-through would hand a nightly job the sandbox's strongest browser.
test("identities count as accounts: card-named when pinned, gone entirely when an unpinned wake fires", () => {
    const identity: Capability = { id: "main", kind: "identity", config: { email: "me@gmail.com", openAccounts: "off" } };
    const cast = [card("outward", ["main", "reddit-work"])];
    expect(turnPersona({ personas: cast, actsAs: "outward", unattended: true }).allows(identity)).toBe(true);
    // A card naming only accounts born from an identity does not get the identity itself.
    expect(turnPersona({ personas: [card("narrow", ["reddit-work"])], actsAs: "narrow", unattended: false }).allows(identity)).toBe(false);
    expect(turnPersona({ personas: cast, actsAs: undefined, unattended: true }).allows(identity)).toBe(false);
    expect(turnPersona({ personas: cast, actsAs: undefined, unattended: false }).allows(identity)).toBe(true);
});

// Powers: permissive by default, and the one case where that flips

// An automation that has never heard of personas keeps working exactly as before; defaulting powers to nothing would be
// a migration dressed as a security default.
test("an unpinned wake keeps the full toolbox even though it has lost every account", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: true });
    expect(persona.powers.files).toBe("write");
    expect(persona.powers.shell).toBe(true);
    // `code` is the JS execution backend; defaults open like every other shelf.
    expect(persona.powers.code).toBe(true);
    expect(personaDisallowedTools(persona, [])).toEqual([]);
    // Connectors, devices and MCP all pass too: absent means every one of them.
    expect(persona.allows(connector("github"))).toBe(true);
    expect(persona.allows(device("laptop"))).toBe(true);
    expect(persona.allows(mcp("linear"))).toBe(true);
});

// A missing card fails closed on both accounts and tools, not just accounts: otherwise a Front Desk pinned to a deleted
// card would regain a shell for anonymous visitors. A missing card is ordinary, not corruption.
test("naming a persona no card carries denies everything: accounts and tools alike", () => {
    const persona = turnPersona({ personas: CAST, actsAs: "studio", unattended: false });
    expect(persona.reason).toBe("unknown-persona");
    expect(persona.persona).toBeUndefined();
    expect(persona.allows(browser("reddit-work"))).toBe(false);
    expect(persona.allows(connector("github"))).toBe(false);
    expect(persona.powers.shell).toBe(false);
    // Both execution backends fail closed here too.
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
    expect(denied).not.toContain("Read");
    expect(denied).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", "WebFetch", "Agent"]));
});

test("files: none takes the reading tools away too", () => {
    const persona = turnPersona({ personas: [card("blind", [], { powers: powers({ files: "none" }) })], actsAs: "blind", unattended: true });
    expect(personaDisallowedTools(persona, [])).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Edit", "Write"]));
});

// The skill of a capability this turn cannot reach

// Skill files are written once per workspace, so a turn can read an account's instructions even without its tools. The
// instructions must be denied with the tools, or a disabled account reads as a broken login instead of hidden.
test("an unattended wake loses the skills of the accounts it lost", () => {
    const persona = turnPersona({ personas: CAST, actsAs: undefined, unattended: true });
    const denied = personaDisallowedTools(persona, [browser("reddit-work"), connector("github")]);
    expect(denied).toContain("Skill(reddit-work)");
    // The connector's skill survives: it isn't an account, and hiding it would remove a still-working tool.
    expect(denied).not.toContain("Skill(github)");
});

test("a card keeps its own accounts' skills and loses everyone else's", () => {
    const persona = turnPersona({ personas: CAST, actsAs: "work", unattended: true });
    const denied = personaDisallowedTools(persona, [browser("reddit-work"), browser("reddit-personal"), browser("npmjs")]);
    expect(denied).not.toContain("Skill(reddit-work)");
    // Same answer either way: one belongs to another card, one to none, but this turn can act on neither.
    expect(denied).toEqual(expect.arrayContaining(["Skill(reddit-personal)", "Skill(npmjs)"]));
});

test("every denied kind loses its skill, not just accounts", () => {
    const persona = turnPersona({
        personas: [card("narrow", ["github"], { powers: powers({ connectors: ["github"], devices: [], mcp: [] }) })],
        actsAs: "narrow",
        unattended: true,
    });
    const denied = personaDisallowedTools(persona, [connector("github"), connector("linear"), device("laptop"), mcp("notion")]);
    expect(denied).not.toContain("Skill(github)");
    expect(denied).toEqual(expect.arrayContaining(["Skill(linear)", "Skill(laptop)", "Skill(notion)"]));
});

// The manifest, narrowed once

// Narrowing kinds the card has no opinion about would silently deny any capability kind added later.
test("a card filters accounts, connectors, devices and MCP; other kinds pass through", () => {
    const installed: Capability[] = [
        browser("reddit-work"),
        browser("reddit-personal"),
        connector("github"),
        connector("komodo"),
        device("laptop"),
        mcp("linear"),
        { id: "pi", kind: "agent", config: { command: "pi" } },
    ];
    const persona = turnPersona({
        personas: [card("work", ["reddit-work"], { powers: powers({ connectors: ["github"], devices: [], mcp: [] }) })],
        actsAs: "work",
        unattended: true,
    });
    const visible = personaCapabilities(installed, persona);
    // The agent runtime itself always passes: a persona that could switch off its own runtime would only confuse.
    expect(visible.map((capability) => capability.id)).toEqual(["reddit-work", "github", "pi"]);
});

test("an unpinned wake keeps its non-account capabilities while losing every logged-in account", () => {
    const installed: Capability[] = [browser("reddit-work"), mcp("linear")];
    const visible = personaCapabilities(installed, turnPersona({ personas: CAST, actsAs: undefined, unattended: true }));
    expect(visible.map((capability) => capability.id)).toEqual(["linear"]);
});

// Removed entirely, not merely told not to use: the difference between a fence and advice.
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

// Environment holds more than credentials (PATH, extension settings); granting everything returns it untouched.
test("a card that grants every connector leaves the environment exactly as it was", () => {
    const cliEnv = { GITHUB_TOKEN_GITHUB: "gh-secret", PATH: "/usr/bin" };
    const persona = turnPersona({ personas: CAST, actsAs: "work", unattended: true });
    expect(personaCliEnv(cliEnv, [connector("github")], persona, suffix)).toBe(cliEnv);
});

// What the turn is told

test("the note names the persona and says its accounts are the only ones", () => {
    const label = "Work Reddit";
    const note = personaNote(
        turnPersona({
            personas: [card("work", ["reddit-work"], { label })],
            actsAs: "work",
            unattended: true,
        }),
    );
    expect(note).toContain(label);
    expect(note?.length).toBeGreaterThan(label.length);
});

// Front Desk's manner comes from the daemon, not a card field; this proves the guidance reaches the turn.
test("the front desk's own manner rides its note, and no other card's", () => {
    const desk = personaNote(turnPersona({ personas: [card(FRONT_DESK_PERSONA, [])], actsAs: FRONT_DESK_PERSONA, unattended: true }));
    const work = personaNote(turnPersona({ personas: CAST, actsAs: "work", unattended: true }));
    expect(desk).not.toBe(work);
    expect(desk).not.toEqual(work);
});

// Folder limits are narrated, unlike tool shelves: an absent tool teaches by being absent, but a path refusal mid-task
// reads as broken unless the agent already knows where it may work.
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

// Nothing to narrate when nothing changed: tools missing is enough, without a paragraph about it.
test("no note for an open attended turn, nor for an unpinned wake", () => {
    expect(personaNote(turnPersona({ personas: CAST, actsAs: undefined, unattended: false }))).toBeUndefined();
    expect(personaNote(turnPersona({ personas: CAST, actsAs: undefined, unattended: true }))).toBeUndefined();
});

// The prompt: the fourth question the card answers

// Sandbox's answer is the default; absent rather than spelling "inherit", so an old card changes nothing.
const SETTINGS = { systemPromptMode: "intentic", systemPrompt: "" } as const;

test("a card that says nothing about the prompt runs on the sandbox's", () => {
    expect(personaPrompt(card("work", []), undefined, SETTINGS)).toEqual({ mode: "intentic", systemPrompt: "" });
    // Same for a turn wearing no card at all.
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

// A built-in base carries no text and must not inherit the sandbox's custom prompt, or a "claude" persona would run
// Claude's preset while the composer's custom field still shows the sandbox's unrelated text.
test("a card on a built-in base takes the base and none of the sandbox's text", () => {
    expect(
        personaPrompt(card("work", [], { systemPromptMode: "claude" }), undefined, { systemPromptMode: "custom", systemPrompt: "Sandbox." }),
    ).toEqual({ mode: "claude", systemPrompt: "" });
});

// Custom with nothing written yet is mid-edit, not a decision to run on a blank prompt.
test("custom with nothing written yet falls back to the sandbox", () => {
    expect(personaPrompt(card("desk", [], { systemPromptMode: "custom" }), undefined, SETTINGS)).toEqual({ mode: "intentic", systemPrompt: "" });
});

// The card is a static context

// A card's effects are a pure function of the card alone: two turns wearing the same card must produce the identical
// note, tool set and prompt placement, so a provider's prompt cache can serve one from the other.
test("two turns wearing one card get identical persona-derived context, and a different card gets a different one", () => {
    const backend: Persona = { id: "backend", label: "Backend", capabilities: ["github-work"], powers: powers({ shell: false }), workspace: { folders: ["api"] } };
    const cast = [...CAST, backend];
    const installed = [browser("reddit-work"), connector("github-work"), connector("stripe")];
    const wear = (unattended: boolean) => turnPersona({ personas: cast, actsAs: "backend", unattended });
    const first = wear(false);
    const second = wear(true);
    expect(personaNote(second)).toBe(personaNote(first));
    expect(personaDisallowedTools(second, installed)).toEqual(personaDisallowedTools(first, installed));
    expect(personaCapabilities(installed, second)).toEqual(personaCapabilities(installed, first));
    expect(personaPrompt(second.persona, undefined, { systemPromptMode: "intentic", systemPrompt: "" })).toEqual(
        personaPrompt(first.persona, undefined, { systemPromptMode: "intentic", systemPrompt: "" }),
    );
    const other = turnPersona({ personas: cast, actsAs: "work", unattended: false });
    expect(personaNote(other)).not.toBe(personaNote(first));
    expect(personaDisallowedTools(other, installed)).not.toEqual(personaDisallowedTools(first, installed));
});
