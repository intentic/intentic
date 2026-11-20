import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { FULL_ACCESS_ROLE, NO_ACCOUNTS_ROLE, type Role, VISITOR_CHAT_ROLE } from "@intentic/sandbox-contract/schemas/roles";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import {
    capRole,
    roleCapabilities,
    roleCliEnv,
    roleDisallowedTools,
    roleFence,
    roleNote,
    rolePrompt,
    roleWithheldAccounts,
    turnRole,
    UNATTENDED_ACCOUNTS_TITLE,
    unattendedAccountsNote,
} from "./roles.js";

const roleOf = (id: string, capabilities: readonly string[], extra: Partial<Role> = {}): Role => ({
    id,
    capabilities: [...capabilities],
    ...extra,
});

// A card worn under the ceiling its access holds it to: an access profile listing it, resolved by the principal chain.
const wornUnder = (card: Role, ceiling: ToolCeiling, unattended = true) =>
    capRole(turnRole({ roles: [card], actsAs: card.id, unattended }), ceiling);

const browser = (id: string): Capability => ({ id, kind: "browser", config: { platform: "reddit" } });
const connector = (id: string): Capability => ({ id, kind: "cli", config: { provider: id } });
const device = (id: string): Capability => ({
    id,
    kind: "device",
    config: {
        platform: "linux",
        shell: "on",
        write: "on",
        screen: "off",
        control: "off",
        sandboxes: "off",
        destructive: "off",
        programs: "off",
        remoteView: "off",
        remoteControl: "off",
        remoteTerminal: "off",
    },
});
const mcp = (id: string): Capability => ({ id, kind: "mcp", config: { url: "https://a/mcp" } });

const CAST = [roleOf("work", ["reddit-work", "x-work"]), roleOf("personal", ["reddit-personal"])];

// Suffix scheme cli-env.ts uses, restated rather than imported so a drift there fails here too.
const suffix = (id: string): string => id.toUpperCase().replaceAll("-", "_");

// Accounts: the half that predates the shelves

test("an attended turn that names no role wears Full access: every account", () => {
    const role = turnRole({ roles: CAST, actsAs: undefined, unattended: false });
    expect(role.reason).toBe("full-access");
    expect(role.builtIn).toBe(FULL_ACCESS_ROLE);
    expect(role.role).toBeUndefined();
    expect(role.allows(browser("reddit-work"))).toBe(true);
    expect(role.allows(browser("reddit-personal"))).toBe(true);
    // "Everything" means the whole manifest, even an account no role names.
    expect(role.allows(browser("npmjs"))).toBe(true);
});

test("an unattended wake that names no role wears No accounts: it reaches no account at all", () => {
    const role = turnRole({ roles: CAST, actsAs: undefined, unattended: true });
    expect(role.reason).toBe("no-accounts");
    expect(role.builtIn).toBe(NO_ACCOUNTS_ROLE);
    expect(role.allows(browser("reddit-work"))).toBe(false);
    expect(role.allows(browser("reddit-personal"))).toBe(false);
});

// The built-ins are roles like any other: naming one wears it whoever is watching, so an automation can act as Full
// access, and a person can pick No accounts for a chat that must not post as anyone.
test("naming a built-in wears it whether or not anyone is watching", () => {
    for (const unattended of [false, true]) {
        const full = turnRole({ roles: CAST, actsAs: FULL_ACCESS_ROLE, unattended });
        expect(full.reason).toBe("full-access");
        expect(full.allows(browser("npmjs"))).toBe(true);
        expect(full.powers.shell).toBe(true);
        const none = turnRole({ roles: CAST, actsAs: NO_ACCOUNTS_ROLE, unattended });
        expect(none.reason).toBe("no-accounts");
        expect(none.allows(browser("reddit-work"))).toBe(false);
        expect(none.allows(connector("github"))).toBe(true);
        expect(none.powers.shell).toBe(true);
    }
});

// A built-in id is reserved: a card carrying one (written by hand before the reservation) never shadows the built-in,
// or a card named "full-access" could quietly narrow every automation that picked Full access.
test("a card carrying a built-in's id never shadows the built-in", () => {
    const squatter = [roleOf(FULL_ACCESS_ROLE, []), roleOf(NO_ACCOUNTS_ROLE, ["reddit-work"])];
    expect(turnRole({ roles: squatter, actsAs: FULL_ACCESS_ROLE, unattended: true }).allows(browser("npmjs"))).toBe(true);
    expect(turnRole({ roles: squatter, actsAs: NO_ACCOUNTS_ROLE, unattended: false }).allows(browser("reddit-work"))).toBe(false);
});

// The fence the conversation was born with still holds: a built-in widens accounts, never folders.
test("a built-in keeps the conversation's own fence", () => {
    expect(turnRole({ roles: CAST, actsAs: FULL_ACCESS_ROLE, unattended: false, fence: ["web"] }).fence).toEqual(["web"]);
    expect(turnRole({ roles: CAST, actsAs: undefined, unattended: true, fence: ["web"] }).fence).toEqual(["web"]);
});

test("a named role is narrowed to exactly its own accounts, attended or not", () => {
    for (const unattended of [false, true]) {
        const role = turnRole({ roles: CAST, actsAs: "work", unattended });
        expect(role.reason).toBe("role");
        expect(role.role?.id).toBe("work");
        expect(role.allows(browser("reddit-work"))).toBe(true);
        expect(role.allows(browser("x-work"))).toBe(true);
        expect(role.allows(browser("reddit-personal"))).toBe(false);
    }
});

// The owner's own browser holds every session they have, so it is an account, not a service that passes untouched.
// 2026-10-25: an X-only role's automation reached for the owner's Brave and raised "Allow x.com" at 22:10.
test("the owner's own browser reaches a turn only as an account does", () => {
    const chrome: Capability = {
        id: "chrome",
        kind: "webext",
        config: { platform: "chrome", read: "on", act: "on", screenshot: "off", cookies: "off", scripts: "off", confirm: "sensitive" },
    };
    const cast = [roleOf("marketing", ["x"]), roleOf("browsing", ["chrome"])];
    expect(turnRole({ roles: cast, actsAs: undefined, unattended: false }).allows(chrome)).toBe(true);
    expect(turnRole({ roles: cast, actsAs: undefined, unattended: true }).allows(chrome)).toBe(false);
    expect(turnRole({ roles: cast, actsAs: "marketing", unattended: true }).allows(chrome)).toBe(false);
    expect(turnRole({ roles: cast, actsAs: "browsing", unattended: true }).allows(chrome)).toBe(true);
    // Withheld like an account, so the unpinned wake is told it was this rule and not a broken extension.
    const unpinned = turnRole({ roles: cast, actsAs: undefined, unattended: true });
    expect(roleWithheldAccounts([chrome, connector("github")], unpinned).map((capability) => capability.id)).toEqual(["chrome"]);
    // Its skill is denied by name, the same way an account's is.
    expect(roleDisallowedTools(turnRole({ roles: cast, actsAs: "marketing", unattended: true }), [chrome])).toContain("Skill(chrome)");
});

test("a role with an empty role allows nothing, which is not the same as naming none", () => {
    const role = turnRole({ roles: [roleOf("mute", [])], actsAs: "mute", unattended: false });
    expect(role.reason).toBe("role");
    expect(role.allows(browser("reddit-work"))).toBe(false);
});

// An identity is more credential than any account: it follows the same rule, named to be granted, first thing an
// unpinned wake loses. A blanket pass-through would hand a nightly job the sandbox's strongest browser.
test("identities count as accounts: card-named when pinned, gone entirely when an unpinned wake fires", () => {
    const identity: Capability = { id: "main", kind: "identity", config: { email: "me@gmail.com", openAccounts: "off" } };
    const cast = [roleOf("outward", ["main", "reddit-work"])];
    expect(turnRole({ roles: cast, actsAs: "outward", unattended: true }).allows(identity)).toBe(true);
    // A role naming only accounts born from an identity does not get the identity itself.
    expect(turnRole({ roles: [roleOf("narrow", ["reddit-work"])], actsAs: "narrow", unattended: false }).allows(identity)).toBe(false);
    expect(turnRole({ roles: cast, actsAs: undefined, unattended: true }).allows(identity)).toBe(false);
    expect(turnRole({ roles: cast, actsAs: undefined, unattended: false }).allows(identity)).toBe(true);
});

// Powers: permissive by default, and the one case where that flips

// An automation that has never heard of roles keeps working exactly as before; defaulting powers to nothing would be
// a migration dressed as a security default.
test("an unpinned wake keeps the full toolbox even though it has lost every account", () => {
    const role = turnRole({ roles: CAST, actsAs: undefined, unattended: true });
    expect(role.powers.files).toBe("write");
    expect(role.powers.shell).toBe(true);
    // `code` is the JS execution backend; defaults open like every other shelf.
    expect(role.powers.code).toBe(true);
    expect(roleDisallowedTools(role, [])).toEqual([]);
    // Connectors, devices and MCP all pass too: absent means every one of them.
    expect(role.allows(connector("github"))).toBe(true);
    expect(role.allows(device("laptop"))).toBe(true);
    expect(role.allows(mcp("linear"))).toBe(true);
});

// A missing role fails closed on both accounts and tools, not just accounts: otherwise a Visitor chat pinned to a deleted
// role would regain a shell for anonymous visitors. A missing role is ordinary, not corruption.
test("naming a role no role carries denies everything: accounts and tools alike", () => {
    const role = turnRole({ roles: CAST, actsAs: "studio", unattended: false });
    expect(role.reason).toBe("unknown-role");
    expect(role.role).toBeUndefined();
    expect(role.allows(browser("reddit-work"))).toBe(false);
    expect(role.allows(connector("github"))).toBe(false);
    expect(role.powers.shell).toBe(false);
    // Both execution backends fail closed here too.
    expect(role.powers.code).toBe(false);
    expect(roleDisallowedTools(role, [])).toContain("Bash");
    expect(roleDisallowedTools(role, [])).toContain("Read");
});

test("a card's shelves are the full toolbox until its access holds it under a ceiling", () => {
    expect(turnRole({ roles: [roleOf("reader", [])], actsAs: "reader", unattended: true }).powers.shell).toBe(true);
});

test("the shelves a role's access holds back become the tools taken out of the turn", () => {
    const role = wornUnder(roleOf("reader", []), { files: "read", shell: false, web: false, browser: false, delegate: false, sandbox: false });
    const denied = roleDisallowedTools(role, []);
    expect(denied).not.toContain("Read");
    expect(denied).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", "WebFetch", "Agent"]));
});

test("files: none takes the reading tools away too", () => {
    const role = wornUnder(roleOf("blind", []), { files: "none" });
    expect(roleDisallowedTools(role, [])).toEqual(expect.arrayContaining(["Read", "Grep", "Glob", "Edit", "Write"]));
});

// The skill of a capability this turn cannot reach

// Skill files are written once per workspace, so a turn can read an account's instructions even without its tools. The
// instructions must be denied with the tools, or a disabled account reads as a broken login instead of hidden.
test("an unattended wake loses the skills of the accounts it lost", () => {
    const role = turnRole({ roles: CAST, actsAs: undefined, unattended: true });
    const denied = roleDisallowedTools(role, [browser("reddit-work"), connector("github")]);
    expect(denied).toContain("Skill(reddit-work)");
    // The connector's skill survives: it isn't an account, and hiding it would remove a still-working tool.
    expect(denied).not.toContain("Skill(github)");
});

test("a role keeps its own accounts' skills and loses everyone else's", () => {
    const role = turnRole({ roles: CAST, actsAs: "work", unattended: true });
    const denied = roleDisallowedTools(role, [browser("reddit-work"), browser("reddit-personal"), browser("npmjs")]);
    expect(denied).not.toContain("Skill(reddit-work)");
    // Same answer either way: one belongs to another role, one to none, but this turn can act on neither.
    expect(denied).toEqual(expect.arrayContaining(["Skill(reddit-personal)", "Skill(npmjs)"]));
});

// A card decides only its accounts: a connector, device or server it is held back from is its access's to withhold, and
// the reach leaves that skill out (honoured.ts), not the card.
test("a card denies only the skills of the accounts it does not speak through", () => {
    const role = turnRole({ roles: [roleOf("narrow", ["github"])], actsAs: "narrow", unattended: true });
    const denied = roleDisallowedTools(role, [connector("linear"), device("laptop"), mcp("notion"), browser("reddit-work")]);
    expect(denied).toEqual(["Skill(reddit-work)"]);
});

// The manifest, narrowed once

// Narrowing kinds the role has no opinion about would silently deny any capability kind added later; connectors,
// devices and servers are its access's to narrow, in the credential reach.
test("a role filters accounts; every other kind passes through to its access", () => {
    const installed: Capability[] = [
        browser("reddit-work"),
        browser("reddit-personal"),
        connector("github"),
        connector("komodo"),
        device("laptop"),
        mcp("linear"),
        { id: "pi", kind: "agent", config: { command: "pi" } },
    ];
    const role = turnRole({ roles: [roleOf("work", ["reddit-work"])], actsAs: "work", unattended: true });
    const visible = roleCapabilities(installed, role);
    // The agent runtime itself always passes: a role that could switch off its own runtime would only confuse.
    expect(visible.map((capability) => capability.id)).toEqual(["reddit-work", "github", "komodo", "laptop", "linear", "pi"]);
});

test("handing a linked sandbox work needs the delegate shelf", () => {
    const link: Capability = { id: "ops", kind: "link", config: { url: "https://sandbox-ops.sbx.test", token: "ilk_x" } };
    expect(turnRole({ roles: [roleOf("p", [])], actsAs: "p", unattended: false }).allows(link)).toBe(true);
    expect(wornUnder(roleOf("p", []), { delegate: false }, false).allows(link)).toBe(false);
});

test("making sandboxes on the owner's account follows the sandbox shelf", () => {
    const fleet: Capability = { id: "fleet", kind: "fleet", config: { token: "itk_x" } };
    expect(wornUnder(roleOf("tidy", []), { sandbox: false }, false).allows(fleet)).toBe(false);
    expect(wornUnder(roleOf("admin", []), {}, false).allows(fleet)).toBe(true);
});

test("an unpinned wake keeps its non-account capabilities while losing every logged-in account", () => {
    const installed: Capability[] = [browser("reddit-work"), mcp("linear")];
    const visible = roleCapabilities(installed, turnRole({ roles: CAST, actsAs: undefined, unattended: true }));
    expect(visible.map((capability) => capability.id)).toEqual(["linear"]);
});

// Removed entirely, not merely told not to use: the difference between a fence and advice. A connector a role's access
// holds back is the reach's to strip (reachCliEnv); a named-but-missing card allows nothing, so it strips every one.
test("a missing card's connector credentials are removed from the shell environment", () => {
    const installed = [connector("github"), connector("komodo")];
    const cliEnv = {
        GITHUB_TOKEN_GITHUB: "gh-secret",
        KOMODO_KEY_KOMODO: "komodo-secret",
        KOMODO_SECRET_KOMODO: "komodo-secret-2",
        PATH: "/usr/bin",
    };
    const role = turnRole({ roles: [], actsAs: "ci", unattended: true });
    expect(roleCliEnv(cliEnv, installed, role, suffix)).toEqual({ PATH: "/usr/bin" });
});

// Environment holds more than credentials (PATH, extension settings); granting everything returns it untouched.
test("a role that grants every connector leaves the environment exactly as it was", () => {
    const cliEnv = { GITHUB_TOKEN_GITHUB: "gh-secret", PATH: "/usr/bin" };
    const role = turnRole({ roles: CAST, actsAs: "work", unattended: true });
    expect(roleCliEnv(cliEnv, [connector("github")], role, suffix)).toBe(cliEnv);
});

// What the turn is told

test("the note names the role and says its accounts are the only ones", () => {
    const label = "Work Reddit";
    const note = roleNote(
        turnRole({
            roles: [roleOf("work", ["reddit-work"], { label })],
            actsAs: "work",
            unattended: true,
        }),
    );
    expect(note).toContain(label);
    expect(note?.length).toBeGreaterThan(label.length);
});

// Visitor chat's manner comes from the daemon, not a role field; this proves the guidance reaches the turn.
test("the visitor chat's own manner rides its note, and no other role's", () => {
    const guest = roleNote(turnRole({ roles: [roleOf(VISITOR_CHAT_ROLE, [])], actsAs: VISITOR_CHAT_ROLE, unattended: true }));
    const work = roleNote(turnRole({ roles: CAST, actsAs: "work", unattended: true }));
    expect(guest).not.toBe(work);
    expect(guest).not.toEqual(work);
});

// Folder limits are narrated, unlike tool shelves: an absent tool teaches by being absent, but a path refusal mid-task
// reads as broken unless the agent already knows where it may work.
test("the note names the folders the role's access holds it to", () => {
    const note = roleNote(
        turnRole({
            roles: [roleOf("app", [])],
            actsAs: "app",
            unattended: true,
            roleFence: ["apps/web", "packages/ui"],
        }),
    );
    expect(note).toContain("apps/web, packages/ui");
});

// Nothing to narrate when nothing changed: tools missing is enough, without a paragraph about it.
test("no note for an open attended turn, nor for an unpinned wake", () => {
    expect(roleNote(turnRole({ roles: CAST, actsAs: undefined, unattended: false }))).toBeUndefined();
    expect(roleNote(turnRole({ roles: CAST, actsAs: undefined, unattended: true }))).toBeUndefined();
});

// The prompt: the fourth question the role answers

// Sandbox's answer is the default; absent rather than spelling "inherit", so an old role changes nothing.
const SETTINGS = { systemPromptMode: "intentic", systemPrompt: "" } as const;

test("a role that says nothing about the prompt runs on the sandbox's", () => {
    expect(rolePrompt(roleOf("work", []), undefined, SETTINGS)).toEqual({ mode: "intentic", systemPrompt: "" });
    // Same for a turn wearing no role at all.
    expect(rolePrompt(undefined, undefined, { systemPromptMode: "custom", systemPrompt: "Sandbox text." })).toEqual({
        mode: "custom",
        systemPrompt: "Sandbox text.",
    });
});

test("a role with its own prompt replaces the sandbox's, text and all", () => {
    const guest = roleOf("guest", [], { systemPromptMode: "custom" });
    expect(rolePrompt(guest, "You are a release-notes writer.", { systemPromptMode: "intentic", systemPrompt: "" })).toEqual({
        mode: "custom",
        systemPrompt: "You are a release-notes writer.",
    });
});

// A built-in base carries no text and must not inherit the sandbox's custom prompt, or a "claude" role would run
// Claude's preset while the composer's custom field still shows the sandbox's unrelated text.
test("a role on a built-in base takes the base and none of the sandbox's text", () => {
    expect(
        rolePrompt(roleOf("work", [], { systemPromptMode: "claude" }), undefined, { systemPromptMode: "custom", systemPrompt: "Sandbox." }),
    ).toEqual({ mode: "claude", systemPrompt: "" });
});

// Custom with nothing written yet is mid-edit, not a decision to run on a blank prompt.
test("custom with nothing written yet falls back to the sandbox", () => {
    expect(rolePrompt(roleOf("guest", [], { systemPromptMode: "custom" }), undefined, SETTINGS)).toEqual({
        mode: "intentic",
        systemPrompt: "",
    });
});

// The role is a static context

// A role's effects are a pure function of the role alone: two turns wearing the same role must produce the identical
// note, tool set and prompt placement, so a provider's prompt cache can serve one from the other.
test("two turns wearing one role get identical role-derived context, and a different role gets a different one", () => {
    const backend: Role = { id: "backend", label: "Backend", capabilities: ["github-work"] };
    const cast = [...CAST, backend];
    const installed = [browser("reddit-work"), connector("github-work"), connector("stripe")];
    const wear = (unattended: boolean) => capRole(turnRole({ roles: cast, actsAs: "backend", unattended, roleFence: ["api"] }), { shell: false });
    const first = wear(false);
    const second = wear(true);
    expect(roleNote(second)).toBe(roleNote(first));
    expect(roleDisallowedTools(second, installed)).toEqual(roleDisallowedTools(first, installed));
    expect(roleCapabilities(installed, second)).toEqual(roleCapabilities(installed, first));
    expect(rolePrompt(second.role, undefined, { systemPromptMode: "intentic", systemPrompt: "" })).toEqual(
        rolePrompt(first.role, undefined, { systemPromptMode: "intentic", systemPrompt: "" }),
    );
    const other = turnRole({ roles: cast, actsAs: "work", unattended: false });
    expect(roleNote(other)).not.toBe(roleNote(first));
    expect(roleDisallowedTools(other, installed)).not.toEqual(roleDisallowedTools(first, installed));
});

// The note the fence owes itself

// The rule that takes the accounts away is right; being silent about it is what cost an hour. The turn has to be told,
// because from inside it a withheld account and a broken one look identical.
test("an unattended wake is told which accounts it lost, and that they are not broken", () => {
    const role = turnRole({ roles: CAST, actsAs: undefined, unattended: true });
    const installed = [browser("npmjs"), browser("reddit-work"), connector("github")];
    const withheld = roleWithheldAccounts(installed, role);
    expect(withheld.map((capability) => capability.id)).toEqual(["npmjs", "reddit-work"]);
    const note = unattendedAccountsNote(role, withheld);
    expect(note?.title).toBe(UNATTENDED_ACCOUNTS_TITLE);
    expect(note?.text).toContain("`npmjs`");
    expect(note?.text).toContain("`reddit-work`");
    // The connector kept its tools, so naming it here would send the turn looking for a problem it doesn't have.
    expect(note?.text).not.toContain("github");
    // And the note says so outright: a turn that reads only the loss concludes its whole environment was emptied, and
    // stops reaching for credentials it still holds.
    expect(note?.text).toContain("connector credential");
});

test("a person who picks No accounts is told the same, since the accounts are just as absent", () => {
    const role = turnRole({ roles: CAST, actsAs: NO_ACCOUNTS_ROLE, unattended: false });
    const note = unattendedAccountsNote(role, roleWithheldAccounts([browser("npmjs")], role));
    expect(note?.title).toBe(UNATTENDED_ACCOUNTS_TITLE);
    expect(note?.text).toContain("No accounts");
});

test("no note when nothing was withheld, and none for a turn wearing a role", () => {
    const attended = turnRole({ roles: CAST, actsAs: undefined, unattended: false });
    expect(unattendedAccountsNote(attended, roleWithheldAccounts([browser("npmjs")], attended))).toBeUndefined();
    // A wake in a sandbox with no accounts connected has lost nothing, and a note about nothing is noise.
    const bare = turnRole({ roles: CAST, actsAs: undefined, unattended: true });
    expect(unattendedAccountsNote(bare, roleWithheldAccounts([connector("github")], bare))).toBeUndefined();
    // A role says the same thing from the other end (roleNote), so this one would be the second voice saying it.
    const wearing = turnRole({ roles: CAST, actsAs: "work", unattended: true });
    expect(unattendedAccountsNote(wearing, roleWithheldAccounts([browser("npmjs")], wearing))).toBeUndefined();
});

// The folders a role's access fences it to: the areas of every profile listing the card, held together.
describe("roleFence", () => {
    const areas = [
        { id: "web", folders: ["apps/web"] },
        { id: "apps", folders: ["apps"] },
        { id: "docs", folders: ["docs"] },
    ];

    it("is no fence of its own for a card no profile lists, a profile naming no areas, a built-in or no role", () => {
        expect(roleFence("writer", [{ roles: ["other"], areas: ["web"] }], areas)).toBeUndefined();
        expect(roleFence("writer", [{ roles: ["writer"] }], areas)).toBeUndefined();
        expect(roleFence(FULL_ACCESS_ROLE, [{ roles: [FULL_ACCESS_ROLE], areas: ["web"] }], areas)).toBeUndefined();
        expect(roleFence(undefined, [{ roles: ["writer"], areas: ["web"] }], areas)).toBeUndefined();
    });

    it("is the folders of the areas a listing profile names, and the narrower of two profiles", () => {
        expect(roleFence("writer", [{ roles: ["writer"], areas: ["web", "docs"] }], areas)).toEqual(["apps/web", "docs"]);
        expect(roleFence("writer", [{ roles: ["writer"], areas: ["apps"] }, { roles: ["writer", "x"], areas: ["web"] }], areas)).toEqual(["apps/web"]);
    });

    // Fail-shut, like a person's areas: an area that no longer exists fences to nothing, never to everything.
    it("fences to nothing when the areas it names are gone", () => {
        expect(roleFence("writer", [{ roles: ["writer"], areas: ["gone"] }], areas)).toEqual([]);
    });
});

describe("capRole", () => {
    const fleet: Capability = { id: "my-account", kind: "fleet", config: { token: "itk_x" } };

    it("leaves the role as it is when nothing caps it", () => {
        const open = turnRole({ roles: [], actsAs: undefined, unattended: false });
        expect(capRole(open, undefined)).toBe(open);
        expect(capRole(open, { shell: true, files: "write" })).toBe(open);
    });

    it("holds a built-in's whole toolbox under the ceiling, the shelves a capability rides included", () => {
        const open = turnRole({ roles: [], actsAs: undefined, unattended: false });
        const capped = capRole(open, { files: "read", shell: false, sandbox: false });
        expect(capped.powers).toEqual({ ...open.powers, files: "read", shell: false, sandbox: false });
        expect(open.allows(fleet)).toBe(true);
        expect(capped.allows(fleet)).toBe(false);
    });

    it("holds a card's toolbox under the ceiling its access sets, and keeps its accounts its own", () => {
        const card = turnRole({ roles: [roleOf("p", ["reddit-work"])], actsAs: "p", unattended: false });
        const capped = capRole(card, { shell: false });
        expect(capped.powers.shell).toBe(false);
        expect(capped.allows(browser("reddit-work"))).toBe(true);
        expect(capped.allows(browser("reddit-personal"))).toBe(false);
    });
});
