import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import { hasSession, markConnected } from "../../browser/sessions/session-store.js";
import { packFragment, readPack } from "../../environment/packs.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { browserUrls, contributionRegistry } from "../contributions.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { echoConfig, secretField } from "../summary.js";
import { browserHandler } from "./browser.handler.js";

// Real first-party `social` extension: every platform's card, login URL and skill come from here.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// Ctx exposing only what browserHandler touches, over a fresh temp workspace; `capabilities` is a mutable array tests
// push onto after apply, mirroring the route's upsert.
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

// Runs apply then the route's post-apply upsert, together: what a real add does.
const applied = async (harness: { ctx: CapabilityCtx; capabilities: Capability[] }, entry: Capability): Promise<void> => {
    for await (const _ of browserHandler.apply(harness.ctx, entry.id, entry.config)) {
    }
    harness.capabilities.push(entry);
};

// Runs the handler's remove hook, then the store's delete, in the route's order.
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
// Site-group skill, named for the platform; shared by every account on it.
const skillPath = (root: string): string => join(root, ".agents", "skills", "reddit", "SKILL.md");

// Builds a generic `website` session with the answers a user would type on its form.
const session = (id: string, homeUrl: string): Capability => ({
    id,
    kind: "browser",
    config: { platform: "website", homeUrl, purpose: "read and reply to supplier tickets" },
});

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
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
    expect(skill).toContain("- `reddit`");
    expect(skill).toMatch(/^description: .*Connected accounts: reddit\./m);
    // Pending regardless of Xvfb: there is no session yet, either way.
    expect((await browserHandler.status(harness.ctx, "reddit", reddit.config)).state).toBe("pending");
});

test("the fragment is the browser pack: Chromium, its display and the tools that make it watchable, as one unit", async () => {
    // Checks the pack's own content, not which image the suite happens to run on.
    const pack = (await readPack("browser"))!;
    expect(pack.content).toContain("xvfb");
    expect(pack.content).toContain("install --with-deps chromium");
    // ffmpeg and xdotool make the browser watchable; missing either fails silently, not as a test.
    expect(pack.content).toContain("ffmpeg");
    expect(pack.content).toContain("xdotool");
    // No PLAYWRIGHT_BROWSERS_PATH override: it would install a second Chromium beside executablePath()'s.
    expect(pack.content).not.toContain("PLAYWRIGHT_BROWSERS_PATH");
    // No `intentic:runtime` line: --no-sandbox here is app-level, not a container privilege.
    expect(pack.content).not.toContain("intentic:runtime");
    // Handler adds nothing of its own: the browser fragment is exactly the pack.
    expect(await browserHandler.fragment!(reddit.config)).toBe(await packFragment("browser"));
});

test("removing the site's last account deletes the group skill; status returns to inactive", async () => {
    const harness = tempCtx();
    await applied(harness, reddit);
    await removed(harness, reddit);
    expect(await readWorkspaceFile(skillPath(harness.root))).toBeUndefined();
    expect(await browserHandler.status(harness.ctx, "reddit", reddit.config)).toEqual({ state: "inactive" });
});

test("an identity-born account's roster line names its identity, and its removal keeps the shared profile", async () => {
    const main: Capability = { id: "main", kind: "identity", config: { email: "studio@gmail.com", openAccounts: "off" } };
    const harness = tempCtx();
    harness.capabilities.push(main);
    const born: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit", identity: "main" } };

    await applied(harness, born);
    const skill = await readWorkspaceFile(skillPath(harness.root));
    expect(skill).toContain("- `reddit`: born of the identity `main` (studio@gmail.com)");
    expect(skill).toContain("SSO FIRST");

    await markConnected(harness.root, "main");
    await markConnected(harness.root, "reddit");
    await removed(harness, born);
    expect(hasSession(harness.root, "reddit")).toBe(false);
    expect(hasSession(harness.root, "main")).toBe(true);

    const dangling: Capability = { id: "x", kind: "browser", config: { platform: "x", identity: "ghost" } };
    await expect(drain(browserHandler.apply(harness.ctx, "x", dangling.config))).rejects.toThrow(/no identity "ghost"/);
});

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
            expect(asks.has("homeUrl"), spec.id).toBe(true);
            expect(spec.fields.find((field) => field.key === "homeUrl")?.optional, spec.id).not.toBe(true);
            expect(asks.has("loginUrl"), spec.id).toBe(true);
        } else {
            expect(spec.loginUrl, spec.id).toMatch(/^https:\/\//);
            // homeUrl is its own field: login only redirects; its origin can differ (YouTube's is accounts.google.com).
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
    // `${tools}`/`${accounts}` are core: the pack marks where they go, the daemon fills them in.
    expect(skill).not.toContain("${tools}");
    expect(skill).not.toContain("${accounts}");
    expect(skill).toContain("browser_snapshot");
    expect(skill).toContain("REAL and public");
    expect(skill).toContain("Accounts on this skill");
});

// npmjs is declared by `connectors`, not `social`: the one browser card outside the social pack.
test("a browser platform contributed by another extension applies the same way", async () => {
    const harness = tempCtx();
    const npmjs: Capability = { id: "npmjs", kind: "browser", config: { platform: "npmjs" } };
    await applied(harness, npmjs);
    const skill = await readWorkspaceFile(join(harness.root, ".agents", "skills", "npmjs", "SKILL.md"));
    expect(skill).toContain("name: npmjs");
    expect(skill).toContain("https://www.npmjs.com");
    // Skill must mention the passkey: without it the agent waits on a 2FA code that no longer exists.
    expect(skill).toContain("passkey");
    expect(skill).toContain("browser_snapshot");
});

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
    expect(secretField(reddit, new Map())).toBeUndefined();
    expect(secretField(credentialed, new Map())).toBe("password");
});

test("a generic browser session connects a site that has no card of its own, grouped by its host", async () => {
    const harness = tempCtx();
    const acme = session("acme", "https://admin.acme.com/dashboard");

    await applied(harness, acme);

    const skill = await readWorkspaceFile(join(harness.root, ".agents", "skills", "admin-acme-com", "SKILL.md"));
    expect(skill).toContain("name: admin-acme-com");
    expect(skill).toMatch(/^description: .*admin\.acme\.com.*Connected accounts: acme\./m);
    expect(skill).toContain("https://admin.acme.com/dashboard");
    expect(skill).toContain("supplier tickets");
    expect(skill).not.toContain("${");
    expect(skill).toContain("browser_snapshot");
    expect(skill).toContain("- `acme`");
    expect((await browserHandler.status(harness.ctx, "acme", acme.config)).state).toBe("pending");
});

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
    // Manifest pins the default; config still overrides it (a preset pointed at a self-hosted instance).
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
    expect(browserUrls(card, { platform: "website" })).toBeUndefined();
});

test("a session with no page to open, or a page that is not a web address, fails the add", async () => {
    const { ctx } = tempCtx();
    await expect(drain(browserHandler.apply(ctx, "acme", { platform: "website", purpose: "x" }))).rejects.toThrow(/needs a page to open/);
    await expect(drain(browserHandler.apply(ctx, "acme", { platform: "website", homeUrl: "admin.acme.com", purpose: "x" }))).rejects.toThrow(
        /not a web address/,
    );
});

test("a second account of the same site is its own connection on the shared site skill", async () => {
    const harness = tempCtx();
    const work: Capability = { id: "reddit-work", kind: "browser", config: { platform: "reddit" } };
    const personal: Capability = { id: "reddit-personal", kind: "browser", config: { platform: "reddit" } };

    await applied(harness, work);
    await applied(harness, personal);

    const skill = await readWorkspaceFile(skillPath(harness.root));
    expect(skill).toContain("- `reddit-work`");
    expect(skill).toContain("- `reddit-personal`");
    expect(skill).toMatch(/^description: .*Connected accounts: reddit-personal, reddit-work\./m);

    // Skipped when the browser pack isn't installed: both accounts then pend on the rebuild instead.
    await markConnected(harness.root, "reddit-work");
    const status = await browserHandler.status(harness.ctx, "reddit-work", work.config);
    if (!String(status.detail ?? "").includes("rebuild")) {
        expect(status).toEqual({ state: "active" });
        expect((await browserHandler.status(harness.ctx, "reddit-personal", personal.config)).detail).toContain("log in");
    }

    await markConnected(harness.root, "reddit-personal");
    await removed(harness, work);
    const remaining = await readWorkspaceFile(skillPath(harness.root));
    expect(remaining).not.toContain("- `reddit-work`");
    expect(remaining).toContain("- `reddit-personal`");
    expect(hasSession(harness.root, "reddit-work")).toBe(false);
    expect(hasSession(harness.root, "reddit-personal")).toBe(true);
});

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

// Scoped by marker, not memory: a hand-written skill with no marker is never converge's to delete.
test("converging the account skills never touches an unmarked skill", async () => {
    const harness = tempCtx();
    const dropped = join(harness.root, ".agents", "skills", "my-notes", "SKILL.md");
    await writeWorkspaceFile(dropped, "---\nname: my-notes\ndescription: hand-written\n---\n\nkeep me\n");

    await applied(harness, reddit);
    await removed(harness, reddit);

    expect(await readWorkspaceFile(dropped)).toContain("keep me");
    expect(await readWorkspaceFile(skillPath(harness.root))).toBeUndefined();
});

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
