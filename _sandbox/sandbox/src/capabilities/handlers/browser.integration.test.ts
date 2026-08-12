import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import { hasSession, markConnected } from "../../browser/session-store.js";
import { packFragment, readPack } from "../../environment/packs.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { browserUrls, contributionRegistry } from "../contributions.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { echoConfig, secretField } from "../summary.js";
import { browserHandler } from "./browser.js";

// The real first-party `social` extension provides every platform's data (card, login URL, skill).
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// A ctx exposing only what browserHandler touches (files + workspace.root + extensionsDir), over a fresh temp
// workspace. `capabilities.list` is what enabledExtensions reads to resolve git-installed extensions.
const tempCtx = (): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "browser-cap-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => [] },
        extensionsDir: EXTENSIONS_DIR,
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

const host: ExtensionHost = {
    workspace: { root: WORKSPACE_ROOT },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => [] },
    config: { extensionsDir: EXTENSIONS_DIR },
} as unknown as ExtensionHost;

const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };
const skillPath = (root: string): string => join(root, ".agents", "skills", "reddit", "SKILL.md");

// A generic session: the `website` card, with the answers a user would type on its form.
const session = (id: string, homeUrl: string): Capability => ({
    id,
    kind: "browser",
    config: { platform: "website", homeUrl, purpose: "read and reply to supplier tickets" },
});

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply writes the platform SKILL.md; status is pending until logged in / rebuilt", async () => {
    const { ctx, root } = tempCtx();
    expect(await browserHandler.status(ctx, "reddit", reddit.config)).toEqual({ state: "inactive" });

    await drain(browserHandler.apply(ctx, "reddit", reddit.config));

    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: reddit");
    expect(skill).toContain("https://www.reddit.com");
    expect(skill).toContain("browser_snapshot");
    // Not yet usable: whether or not the test env has Xvfb, there's no session — either way, pending.
    expect((await browserHandler.status(ctx, "reddit", reddit.config)).state).toBe("pending");
});

test("the fragment is the browser pack — Chromium + Xvfb as one unit, no runtime directive", async () => {
    // The pack rides whole on a core image and composes to nothing on a standard image (stamped base), so
    // WHAT the fragment says is pinned on the pack itself and WHETHER it rides on what the base already
    // bakes — the alternative asserts whichever of the two images the suite happens to run in.
    const pack = (await readPack("browser"))!;
    expect(pack.content).toContain("xvfb");
    expect(pack.content).toContain("install --with-deps chromium");
    // Into playwright's default cache path — a PLAYWRIGHT_BROWSERS_PATH override here would put a second
    // Chromium beside the one chromium.executablePath() resolves.
    expect(pack.content).not.toContain("PLAYWRIGHT_BROWSERS_PATH");
    // App-level --no-sandbox, not a container privilege — the fragment carries no intentic:runtime line.
    expect(pack.content).not.toContain("intentic:runtime");
    // And the handler adds NOTHING of its own: the browser fragment IS the pack, whichever image composes it.
    expect(await browserHandler.fragment!(reddit.config)).toBe(await packFragment("browser"));
});

test("remove deletes the skill dir; status returns to inactive", async () => {
    const { ctx, root } = tempCtx();
    await drain(browserHandler.apply(ctx, "reddit", reddit.config));
    await browserHandler.remove!(ctx, "reddit", reddit.config);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
    expect(await browserHandler.status(ctx, "reddit", reddit.config)).toEqual({ state: "inactive" });
});

/* AN IDENTITY-BORN ACCOUNT'S SKILL NAMES THE IDENTITY'S BROWSER — the account lives in the shared profile, so a
 * skill that still said "your own browser tools" would send the agent to a server that does not exist. The
 * SSO-first playbook and the identity's email ride the same seam, and a dangling reference is caught at
 * add-time rather than surfacing as browser tools over an empty profile. */
test("an identity-born account renders the identity-flavored note, and its removal keeps the shared profile", async () => {
    const main: Capability = { id: "main", kind: "identity", config: { email: "studio@gmail.com", openAccounts: "off" } };
    const { ctx, root } = tempCtx();
    (ctx as { capabilities: unknown }).capabilities = { list: async () => [main], get: async (id: string) => (id === "main" ? main : undefined) };
    const born: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit", identity: "main" } };

    await drain(browserHandler.apply(ctx, "reddit", born.config));
    const skill = await readWorkspaceFile(skillPath(root));
    // The browser tools carry the IDENTITY's prefix, and the playbook leads with the SSO door.
    expect(skill).toContain("mcp__main__browser_");
    expect(skill).toContain("studio@gmail.com");
    expect(skill).toContain("SSO FIRST");

    // Removing the account takes its own marker and skill; the identity's profile marker survives.
    await markConnected(root, "main");
    await markConnected(root, "reddit");
    await browserHandler.remove!(ctx, "reddit", born.config);
    expect(hasSession(root, "reddit")).toBe(false);
    expect(hasSession(root, "main")).toBe(true);

    // A card naming an identity nobody added fails on the form, not turns later.
    const dangling: Capability = { id: "x", kind: "browser", config: { platform: "x", identity: "ghost" } };
    await expect(drain(browserHandler.apply(ctx, "x", dangling.config))).rejects.toThrow(/no identity "ghost"/);
});

/* EVERY BROWSER CARD CAN SAY WHERE IT OPENS — pinned, or asked for. A site card pins both pages; the generic
 * session card pins neither and declares the fields that supply them. What no card may be is silent about both,
 * because that is a card whose login window opens on nothing — and the failure would land on the user, in the
 * one place they cannot fix it. */
test("every contributed browser card can resolve a page to open, and has a skill that leaves room for the core tools note", async () => {
    const registry = await contributionRegistry(host);
    const browsers = [...registry.values()].filter((entry) => entry.spec.kind === "browser");
    expect(browsers.length).toBeGreaterThan(0);
    for (const { spec } of browsers) {
        if (spec.kind !== "browser") {
            continue;
        }
        const asks = new Set(spec.fields.map((field) => field.key));
        if (spec.loginUrl === undefined && spec.homeUrl === undefined) {
            // The generic card: it must ASK for the home page (the one answer it cannot do without) and offer the
            // sign-in page as the optional second, which is exactly what browserUrls falls back through.
            expect(asks.has("homeUrl"), spec.id).toBe(true);
            expect(spec.fields.find((field) => field.key === "homeUrl")?.optional, spec.id).not.toBe(true);
            expect(asks.has("loginUrl"), spec.id).toBe(true);
        } else {
            expect(spec.loginUrl, spec.id).toMatch(/^https:\/\//);
            // Where the OWNER's own window opens once the account is connected. Its own field rather than the login
            // page, which signed in only redirects, and rather than the login URL's origin, which for YouTube is
            // accounts.google.com.
            expect(spec.homeUrl, spec.id).toMatch(/^https:\/\//);
            expect(spec.homeUrl, spec.id).not.toBe(spec.loginUrl);
        }
        expect(spec.skill, spec.id).toMatch(/^skills\/.+\/SKILL\.md$/);
    }
});

test("apply substitutes the core tools note into the contributed skill", async () => {
    const { ctx, root } = tempCtx();
    await drain(browserHandler.apply(ctx, "reddit", reddit.config));
    const skill = await readWorkspaceFile(skillPath(root));
    // The `${tools}` slot is core content (how to drive the shared browser) — the pack declares WHERE it goes,
    // the daemon supplies it, so N platform packs can't drift on it.
    expect(skill).not.toContain("${tools}");
    expect(skill).toContain("browser_snapshot");
    expect(skill).toContain("REAL and public");
});

// npmjs is declared by `connectors`, not `social` — the first browser card outside the social pack, and the
// proof that the handler is generic over WHICH extension contributes a platform rather than over that one.
test("a browser platform contributed by another extension applies the same way", async () => {
    const { ctx, root } = tempCtx();
    const npmjs: Capability = { id: "npmjs", kind: "browser", config: { platform: "npmjs" } };
    await drain(browserHandler.apply(ctx, "npmjs", npmjs.config));
    const skill = await readWorkspaceFile(join(root, ".agents", "skills", "npmjs", "SKILL.md"));
    expect(skill).toContain("name: npmjs");
    expect(skill).toContain("https://www.npmjs.com");
    // The passkey is the reason this card exists: the skill has to tell the agent the 2FA prompt self-answers,
    // or it will stop and ask the user for a code that no longer exists.
    expect(skill).toContain("passkey");
    expect(skill).toContain("browser_snapshot");
});

// Everything echoes EXCEPT the password — masked to hasPassword (the mcp-token precedent), because it is the
// one part of a browser config the browser must never see; a generic session's row still has to be able to
// say which site it points at. The password doubles as the entry's secret, driving the /secrets inventory.
test("echoConfig masks the stored password; it is the browser entry's one secret", () => {
    expect(echoConfig(reddit, new Map())).toEqual({ platform: "reddit" });
    expect(echoConfig(session("acme", "https://admin.acme.com/dashboard"), new Map())).toEqual({
        platform: "website",
        homeUrl: "https://admin.acme.com/dashboard",
        purpose: "read and reply to supplier tickets",
    });
    const credentialed: Capability = {
        id: "reddit-work",
        kind: "browser",
        config: { platform: "reddit", username: "workbot", password: "s3cret!" },
    };
    expect(echoConfig(credentialed, new Map())).toEqual({ platform: "reddit", username: "workbot", hasPassword: true });
    // No password stored ⇒ no secret to inventory; stored ⇒ "password" is the rotatable field.
    expect(secretField(reddit, new Map())).toBeUndefined();
    expect(secretField(credentialed, new Map())).toBe("password");
});

/* THE GENERIC SESSION: a site nobody shipped a card for. Everything the four site cards get from their manifest,
 * this one gets from the form — so what is asserted here is that the two paths converge: a cheatsheet that names
 * the site and the purpose IN ITS FRONTMATTER (the agent routes on that line, and a generic skill silent about
 * its site would never be picked for it), the shared tools note, and the same per-account identity. */
test("a generic browser session connects a site that has no card of its own", async () => {
    const { ctx, root } = tempCtx();
    const acme = session("acme", "https://admin.acme.com/dashboard");

    await drain(browserHandler.apply(ctx, "acme", acme.config));

    const skill = await readWorkspaceFile(join(root, ".agents", "skills", "acme", "SKILL.md"));
    expect(skill).toContain("name: acme");
    // The routing line: the site and the user's own words for what the account is for.
    expect(skill).toMatch(/^description: .*admin\.acme\.com.*supplier tickets/m);
    expect(skill).toContain("https://admin.acme.com/dashboard");
    // Nothing left unsubstituted, and the shared browser instructions landed.
    expect(skill).not.toContain("${");
    expect(skill).toContain("browser_snapshot");
    expect(skill).toContain("THIS SKILL IS ONE ACCOUNT: `acme`");
    // And it is a connection like any other: pending on its own login.
    expect((await browserHandler.status(ctx, "acme", acme.config)).state).toBe("pending");
});

// The sign-in page is the optional second answer: given, it is where the login window goes; omitted, the page the
// account lives on serves as both — because most sites sign in where they live, and asking for the same URL twice
// to prove it would read as a broken form.
test("a session's sign-in page falls back to the page it opens on", () => {
    const card = { kind: "browser", id: "website", fields: [], skill: "s" } as unknown as CapabilityContribution;
    expect(browserUrls(card, { platform: "website", homeUrl: "https://admin.acme.com/dashboard" })).toEqual({
        homeUrl: "https://admin.acme.com/dashboard",
        loginUrl: "https://admin.acme.com/dashboard",
    });
    expect(browserUrls(card, { platform: "website", homeUrl: "https://admin.acme.com/", loginUrl: "https://id.acme.com/signin" })).toEqual({
        homeUrl: "https://admin.acme.com/",
        loginUrl: "https://id.acme.com/signin",
    });
    // A site card's pinned pages still win where the form says nothing, and the form still overrides them — a
    // preset pointed at a self-hosted instance of the same software.
    const pinned = {
        kind: "browser",
        id: "npmjs",
        fields: [],
        skill: "s",
        loginUrl: "https://a/login",
        homeUrl: "https://a/",
    } as unknown as CapabilityContribution;
    expect(browserUrls(pinned, { platform: "npmjs" })).toEqual({ loginUrl: "https://a/login", homeUrl: "https://a/" });
    expect(browserUrls(pinned, { platform: "npmjs", homeUrl: "https://mine/" })?.homeUrl).toBe("https://mine/");
    // Neither answered is the one case that cannot be papered over.
    expect(browserUrls(card, { platform: "website" })).toBeUndefined();
});

// …and the add is where that surfaces, while the reader is still on the form that can fix it.
test("a session with no page to open, or a page that is not a web address, fails the add", async () => {
    const { ctx } = tempCtx();
    await expect(drain(browserHandler.apply(ctx, "acme", { platform: "website", purpose: "x" }))).rejects.toThrow(/needs a page to open/);
    await expect(drain(browserHandler.apply(ctx, "acme", { platform: "website", homeUrl: "admin.acme.com", purpose: "x" }))).rejects.toThrow(
        /not a web address/,
    );
});

/* SEVERAL ACCOUNTS OF ONE SITE. Two entries, one platform, and the identity keyed by the ENTRY: so the second
 * account has its own skill file, is not born connected off the first one's login, and — the one that would hurt
 * most silently — does not take the first account's session with it when disconnected. */
test("a second account of the same site is its own connection", async () => {
    const { ctx, root } = tempCtx();
    const config = { platform: "reddit" };
    const skillOf = (id: string): string => join(root, ".agents", "skills", id, "SKILL.md");

    await drain(browserHandler.apply(ctx, "reddit-work", config));
    await drain(browserHandler.apply(ctx, "reddit-personal", config));

    // Each account's skill names itself, so the agent can tell which browser it is holding.
    expect(await readWorkspaceFile(skillOf("reddit-work"))).toContain("name: reddit-work");
    expect(await readWorkspaceFile(skillOf("reddit-personal"))).toContain("name: reddit-personal");
    expect(await readWorkspaceFile(skillOf("reddit-work"))).toContain("THIS SKILL IS ONE ACCOUNT: `reddit-work`");

    // Signing one in leaves the other waiting for its own login. Only observable where the browser pack is
    // installed — without it BOTH accounts pend on the rebuild first, as the status test above allows for.
    await markConnected(root, "reddit-work");
    const work = await browserHandler.status(ctx, "reddit-work", config);
    if (!String(work.detail ?? "").includes("rebuild")) {
        expect(work).toEqual({ state: "active" });
        expect((await browserHandler.status(ctx, "reddit-personal", config)).detail).toContain("log in");
    }

    // And disconnecting it takes only its own session and skill.
    await markConnected(root, "reddit-personal");
    await browserHandler.remove!(ctx, "reddit-work", config);
    expect(await readWorkspaceFile(skillOf("reddit-work"))).toBeUndefined();
    expect(await readWorkspaceFile(skillOf("reddit-personal"))).toContain("name: reddit-personal");
    expect(hasSession(root, "reddit-work")).toBe(false);
    expect(hasSession(root, "reddit-personal")).toBe(true);
});

// The same guarantee for generic sessions, which is where a user is MOST likely to want two — one site, two
// accounts, and only the form to tell them apart. Two sessions can even sit on one site at different pages.
test("two generic sessions on one site stay separate accounts", async () => {
    const { ctx, root } = tempCtx();
    const support = session("acme-support", "https://admin.acme.com/tickets");
    const billing = session("acme-billing", "https://admin.acme.com/invoices");

    await drain(browserHandler.apply(ctx, support.id, support.config));
    await drain(browserHandler.apply(ctx, billing.id, billing.config));
    await markConnected(root, support.id);

    expect(await readWorkspaceFile(join(root, ".agents", "skills", "acme-support", "SKILL.md"))).toContain("/tickets");
    expect(await readWorkspaceFile(join(root, ".agents", "skills", "acme-billing", "SKILL.md"))).toContain("/invoices");
    expect(hasSession(root, "acme-billing")).toBe(false);

    await browserHandler.remove!(ctx, support.id, support.config);
    expect(hasSession(root, "acme-support")).toBe(false);
    expect(await readWorkspaceFile(join(root, ".agents", "skills", "acme-billing", "SKILL.md"))).toContain("name: acme-billing");
});
