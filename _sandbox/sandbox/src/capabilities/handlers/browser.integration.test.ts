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

/* A ctx exposing only what browserHandler touches (files + workspace.root + extensionsDir + the store), over a
 * fresh temp workspace. The store is a mutable array the tests push applied entries onto, the way the routes
 * upsert after apply: the converge derives every SITE GROUP's skill from it plus the entry mid-apply. */
const tempCtx = (): { ctx: CapabilityCtx; root: string; capabilities: Capability[] } => {
    const root = mkdtempSync(join(tmpdir(), "browser-cap-"));
    const capabilities: Capability[] = [];
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: {
            list: async () => capabilities,
            get: async (id: string) => capabilities.find((entry) => entry.id === id),
        },
        extensionsDir: EXTENSIONS_DIR,
    } as unknown as CapabilityCtx;
    return { ctx, root, capabilities };
};

// Apply + the route's upsert, as one move: what a real add does.
const applied = async (harness: { ctx: CapabilityCtx; capabilities: Capability[] }, entry: Capability): Promise<void> => {
    for await (const _ of browserHandler.apply(harness.ctx, entry.id, entry.config)) {
        // consume the apply frames
    }
    harness.capabilities.push(entry);
};

// The route's remove: the handler hook first, then the store delete.
const removed = async (harness: { ctx: CapabilityCtx; capabilities: Capability[] }, entry: Capability): Promise<void> => {
    await browserHandler.remove!(harness.ctx, entry.id, entry.config);
    harness.capabilities.splice(
        harness.capabilities.findIndex((candidate) => candidate.id === entry.id),
        1,
    );
};

const host: ExtensionHost = {
    workspace: { root: WORKSPACE_ROOT },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => [] },
    config: { extensionsDir: EXTENSIONS_DIR },
} as unknown as ExtensionHost;

const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };
// The site group's skill: named for the PLATFORM, shared by every account on it.
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
    const harness = tempCtx();
    expect(await browserHandler.status(harness.ctx, "reddit", reddit.config)).toEqual({ state: "inactive" });

    await applied(harness, reddit);

    const skill = await readWorkspaceFile(skillPath(harness.root));
    expect(skill).toContain("name: reddit");
    expect(skill).toContain("https://www.reddit.com");
    expect(skill).toContain("browser_snapshot");
    // The account is a roster line, and the catalog line names it.
    expect(skill).toContain("- `reddit`");
    expect(skill).toMatch(/^description: .*Connected accounts: reddit\./m);
    // Not yet usable: whether or not the test env has Xvfb, there's no session, either way, pending.
    expect((await browserHandler.status(harness.ctx, "reddit", reddit.config)).state).toBe("pending");
});

test("the fragment is the browser pack: Chromium + Xvfb as one unit, no runtime directive", async () => {
    // The pack rides whole on a core image and composes to nothing on a standard image (stamped base), so
    // WHAT the fragment says is pinned on the pack itself and WHETHER it rides on what the base already
    // bakes: the alternative asserts whichever of the two images the suite happens to run in.
    const pack = (await readPack("browser"))!;
    expect(pack.content).toContain("xvfb");
    expect(pack.content).toContain("install --with-deps chromium");
    // Into playwright's default cache path: a PLAYWRIGHT_BROWSERS_PATH override here would put a second
    // Chromium beside the one chromium.executablePath() resolves.
    expect(pack.content).not.toContain("PLAYWRIGHT_BROWSERS_PATH");
    // App-level --no-sandbox, not a container privilege: the fragment carries no intentic:runtime line.
    expect(pack.content).not.toContain("intentic:runtime");
    // And the handler adds NOTHING of its own: the browser fragment IS the pack, whichever image composes it.
    expect(await browserHandler.fragment!(reddit.config)).toBe(await packFragment("browser"));
});

test("removing the site's last account deletes the group skill; status returns to inactive", async () => {
    const harness = tempCtx();
    await applied(harness, reddit);
    await removed(harness, reddit);
    expect(await readWorkspaceFile(skillPath(harness.root))).toBeUndefined();
    expect(await browserHandler.status(harness.ctx, "reddit", reddit.config)).toEqual({ state: "inactive" });
});

/* AN IDENTITY-BORN ACCOUNT'S ROSTER LINE NAMES THE IDENTITY: the account lives in the shared profile, and the
 * one fact the old per-account skill existed to carry (WHOSE browser) is now a line beside the account's id.
 * The SSO-first playbook rides the shared tools note, and a dangling reference is caught at add-time rather
 * than surfacing as browser tools over an empty profile. */
test("an identity-born account's roster line names its identity, and its removal keeps the shared profile", async () => {
    const main: Capability = { id: "main", kind: "identity", config: { email: "studio@gmail.com", openAccounts: "off" } };
    const harness = tempCtx();
    harness.capabilities.push(main);
    const born: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit", identity: "main" } };

    await applied(harness, born);
    const skill = await readWorkspaceFile(skillPath(harness.root));
    // The roster line says whose browser this account lives in, and the playbook leads with the SSO door.
    expect(skill).toContain("- `reddit`: born of the identity `main` (studio@gmail.com)");
    expect(skill).toContain("SSO FIRST");

    // Removing the account takes its own marker and roster line; the identity's profile marker survives.
    await markConnected(harness.root, "main");
    await markConnected(harness.root, "reddit");
    await removed(harness, born);
    expect(hasSession(harness.root, "reddit")).toBe(false);
    expect(hasSession(harness.root, "main")).toBe(true);

    // A card naming an identity nobody added fails on the form, not turns later.
    const dangling: Capability = { id: "x", kind: "browser", config: { platform: "x", identity: "ghost" } };
    await expect(drain(browserHandler.apply(harness.ctx, "x", dangling.config))).rejects.toThrow(/no identity "ghost"/);
});

/* EVERY BROWSER CARD CAN SAY WHERE IT OPENS: pinned, or asked for. A site card pins both pages; the generic
 * session card pins neither and declares the fields that supply them. What no card may be is silent about both,
 * because that is a card whose login window opens on nothing, and the failure would land on the user, in the
 * one place they cannot fix it. */
test("every contributed browser card can resolve a page to open, and has a skill that leaves room for the core notes", async () => {
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

test("apply substitutes the core tools note and the roster into the contributed skill", async () => {
    const harness = tempCtx();
    await applied(harness, reddit);
    const skill = await readWorkspaceFile(skillPath(harness.root));
    // The `${tools}` and `${accounts}` slots are core content: the pack declares WHERE they go, the daemon
    // supplies them, so N platform packs can't drift on either.
    expect(skill).not.toContain("${tools}");
    expect(skill).not.toContain("${accounts}");
    expect(skill).toContain("browser_snapshot");
    expect(skill).toContain("REAL and public");
    expect(skill).toContain("Accounts on this skill");
});

// npmjs is declared by `connectors`, not `social`: the first browser card outside the social pack, and the
// proof that the handler is generic over WHICH extension contributes a platform rather than over that one.
test("a browser platform contributed by another extension applies the same way", async () => {
    const harness = tempCtx();
    const npmjs: Capability = { id: "npmjs", kind: "browser", config: { platform: "npmjs" } };
    await applied(harness, npmjs);
    const skill = await readWorkspaceFile(join(harness.root, ".agents", "skills", "npmjs", "SKILL.md"));
    expect(skill).toContain("name: npmjs");
    expect(skill).toContain("https://www.npmjs.com");
    // The passkey is the reason this card exists: the skill has to tell the agent the 2FA prompt self-answers,
    // or it will stop and ask the user for a code that no longer exists.
    expect(skill).toContain("passkey");
    expect(skill).toContain("browser_snapshot");
});

// Everything echoes EXCEPT the password: masked to hasPassword (the mcp-token precedent), because it is the
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

/* THE GENERIC SESSION: a site nobody shipped a card for. Everything the site cards get from their manifest,
 * this one gets from the form, and the accounts GROUP BY THE SITE'S HOST, so the skill's name and catalog
 * line say which site it is (the agent routes on that line, and a generic skill silent about its site would
 * never be picked for it). The purpose lands on the roster line. */
test("a generic browser session connects a site that has no card of its own, grouped by its host", async () => {
    const harness = tempCtx();
    const acme = session("acme", "https://admin.acme.com/dashboard");

    await applied(harness, acme);

    const skill = await readWorkspaceFile(join(harness.root, ".agents", "skills", "admin-acme-com", "SKILL.md"));
    expect(skill).toContain("name: admin-acme-com");
    // The routing line: the site, and the account on it.
    expect(skill).toMatch(/^description: .*admin\.acme\.com.*Connected accounts: acme\./m);
    expect(skill).toContain("https://admin.acme.com/dashboard");
    expect(skill).toContain("supplier tickets");
    // Nothing left unsubstituted, and the shared browser instructions landed.
    expect(skill).not.toContain("${");
    expect(skill).toContain("browser_snapshot");
    expect(skill).toContain("- `acme`");
    // And it is a connection like any other: pending on its own login.
    expect((await browserHandler.status(harness.ctx, "acme", acme.config)).state).toBe("pending");
});

// The sign-in page is the optional second answer: given, it is where the login window goes; omitted, the page the
// account lives on serves as both, because most sites sign in where they live, and asking for the same URL twice
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
    // A site card's pinned pages still win where the form says nothing, and the form still overrides them: a
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

/* SEVERAL ACCOUNTS OF ONE SITE. Two entries, one platform, ONE skill: each account its own roster line and
 * its own login, so the second is not born connected off the first one's session, and: the one that would
 * hurt most silently: does not take the first account's session with it when disconnected. */
test("a second account of the same site is its own connection on the shared site skill", async () => {
    const harness = tempCtx();
    const work: Capability = { id: "reddit-work", kind: "browser", config: { platform: "reddit" } };
    const personal: Capability = { id: "reddit-personal", kind: "browser", config: { platform: "reddit" } };

    await applied(harness, work);
    await applied(harness, personal);

    // One skill for the site, both accounts on its roster and its catalog line: the agent tells them apart
    // by the `account` value, not by which toolset it is holding.
    const skill = await readWorkspaceFile(skillPath(harness.root));
    expect(skill).toContain("- `reddit-work`");
    expect(skill).toContain("- `reddit-personal`");
    expect(skill).toMatch(/^description: .*Connected accounts: reddit-personal, reddit-work\./m);

    // Signing one in leaves the other waiting for its own login. Only observable where the browser pack is
    // installed: without it BOTH accounts pend on the rebuild first, as the status test above allows for.
    await markConnected(harness.root, "reddit-work");
    const status = await browserHandler.status(harness.ctx, "reddit-work", work.config);
    if (!String(status.detail ?? "").includes("rebuild")) {
        expect(status).toEqual({ state: "active" });
        expect((await browserHandler.status(harness.ctx, "reddit-personal", personal.config)).detail).toContain("log in");
    }

    // And disconnecting it takes only its own session and roster line.
    await markConnected(harness.root, "reddit-personal");
    await removed(harness, work);
    const remaining = await readWorkspaceFile(skillPath(harness.root));
    expect(remaining).not.toContain("- `reddit-work`");
    expect(remaining).toContain("- `reddit-personal`");
    expect(hasSession(harness.root, "reddit-work")).toBe(false);
    expect(hasSession(harness.root, "reddit-personal")).toBe(true);
});

// The same guarantee for generic sessions, which is where a user is MOST likely to want two: one site, two
// accounts, and only the form to tell them apart. Two sessions on one site are two roster lines on ITS skill.
test("two generic sessions on one site stay separate accounts on one host-grouped skill", async () => {
    const harness = tempCtx();
    const support = session("acme-support", "https://admin.acme.com/tickets");
    const billing = session("acme-billing", "https://admin.acme.com/invoices");

    await applied(harness, support);
    await applied(harness, billing);
    await markConnected(harness.root, support.id);

    const skill = await readWorkspaceFile(join(harness.root, ".agents", "skills", "admin-acme-com", "SKILL.md"));
    expect(skill).toContain("- `acme-support`: standalone (its own browser and profile) · opens on https://admin.acme.com/tickets");
    expect(skill).toContain("- `acme-billing`: standalone (its own browser and profile) · opens on https://admin.acme.com/invoices");
    expect(hasSession(harness.root, "acme-billing")).toBe(false);

    await removed(harness, support);
    expect(hasSession(harness.root, "acme-support")).toBe(false);
    const remaining = await readWorkspaceFile(join(harness.root, ".agents", "skills", "admin-acme-com", "SKILL.md"));
    expect(remaining).not.toContain("- `acme-support`");
    expect(remaining).toContain("- `acme-billing`");
});

// The sweep is scoped by the MARKER, not by memory: a skill somebody dropped into the loaded folder by hand
// carries no marker and is never the converge's to delete, however the accounts churn around it.
test("converging the account skills never touches an unmarked skill", async () => {
    const harness = tempCtx();
    const dropped = join(harness.root, ".agents", "skills", "my-notes", "SKILL.md");
    await writeWorkspaceFile(dropped, "---\nname: my-notes\ndescription: hand-written\n---\n\nkeep me\n");

    await applied(harness, reddit);
    await removed(harness, reddit);

    expect(await readWorkspaceFile(dropped)).toContain("keep me");
    expect(await readWorkspaceFile(skillPath(harness.root))).toBeUndefined();
});

// Two generic sessions on DIFFERENT sites are two skills: one site's cheatsheet must not claim another's
// accounts, which is the whole reason the generic card groups by host rather than by its own slug.
test("generic sessions on different sites get different skills", async () => {
    const harness = tempCtx();
    await applied(harness, session("acme", "https://admin.acme.com/dashboard"));
    await applied(harness, session("hunt", "https://www.producthunt.com/"));

    expect(await readWorkspaceFile(join(harness.root, ".agents", "skills", "admin-acme-com", "SKILL.md"))).toContain("- `acme`");
    const hunt = await readWorkspaceFile(join(harness.root, ".agents", "skills", "producthunt-com", "SKILL.md"));
    expect(hunt).toContain("- `hunt`");
    expect(hunt).toContain("producthunt.com");
    expect(hunt).not.toContain("- `acme`");
});
