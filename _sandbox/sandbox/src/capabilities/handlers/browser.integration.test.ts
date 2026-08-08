import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { hasSession, markConnected } from "../../browser/session-store.js";
import { packFragment, readPack } from "../../environment/packs.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { contributionRegistry } from "../contributions.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { echoConfig, secretField } from "../summary.js";
import { browserHandler } from "./browser.js";

// The real first-party `social` extension provides every platform's data (card, login URL, skill).
const EXTENSIONS_DIR = fileURLToPath(new URL("../../../../../_extensions", import.meta.url));

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
    workspace: { root: "/work" },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => [] },
    config: { extensionsDir: EXTENSIONS_DIR },
} as unknown as ExtensionHost;

const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };
const skillPath = (root: string): string => join(root, ".claude", "skills", "reddit", "SKILL.md");

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

test("every contributed platform has a real login URL, a home to open on, and a skill that leaves room for the core tools note", async () => {
    const registry = await contributionRegistry(host);
    const browsers = [...registry.values()].filter((entry) => entry.spec.kind === "browser");
    expect(browsers.length).toBeGreaterThan(0);
    for (const { spec } of browsers) {
        if (spec.kind !== "browser") {
            continue;
        }
        expect(spec.loginUrl, spec.id).toMatch(/^https:\/\//);
        // Where the OWNER's own window opens once the account is connected. Its own field rather than the login
        // page, which signed in only redirects, and rather than the login URL's origin, which for YouTube is
        // accounts.google.com.
        expect(spec.homeUrl, spec.id).toMatch(/^https:\/\//);
        expect(spec.homeUrl, spec.id).not.toBe(spec.loginUrl);
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
    const skill = await readWorkspaceFile(join(root, ".claude", "skills", "npmjs", "SKILL.md"));
    expect(skill).toContain("name: npmjs");
    expect(skill).toContain("https://www.npmjs.com");
    // The passkey is the reason this card exists: the skill has to tell the agent the 2FA prompt self-answers,
    // or it will stop and ask the user for a code that no longer exists.
    expect(skill).toContain("passkey");
    expect(skill).toContain("browser_snapshot");
});

test("echoConfig exposes only the platform; browser holds no manifest secret", () => {
    expect(echoConfig(reddit, new Map())).toEqual({ platform: "reddit" });
    expect(secretField(reddit, new Map())).toBeUndefined();
});

/* SEVERAL ACCOUNTS OF ONE SITE. Two entries, one platform, and the identity keyed by the ENTRY: so the second
 * account has its own skill file, is not born connected off the first one's login, and — the one that would hurt
 * most silently — does not take the first account's session with it when disconnected. */
test("a second account of the same site is its own connection", async () => {
    const { ctx, root } = tempCtx();
    const config = { platform: "reddit" };
    const skillOf = (id: string): string => join(root, ".claude", "skills", id, "SKILL.md");

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
