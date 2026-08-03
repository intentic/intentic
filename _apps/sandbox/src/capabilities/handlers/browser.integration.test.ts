import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
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
    // Not yet usable: Chromium isn't installed in the test env and there's no session — either way, pending.
    expect((await browserHandler.status(ctx, "reddit", reddit.config)).state).toBe("pending");
});

test("the fragment installs Chromium via Playwright; no runtime directive needed", () => {
    expect(browserHandler.fragment!(reddit.config)).toContain("playwright/cli.js install");
    expect(browserHandler.fragment!(reddit.config)).toContain("chromium");
    // App-level --no-sandbox, not a container privilege — the fragment carries no intentic:runtime line.
    expect(browserHandler.fragment!(reddit.config)).not.toContain("intentic:runtime");
});

test("remove deletes the skill dir; status returns to inactive", async () => {
    const { ctx, root } = tempCtx();
    await drain(browserHandler.apply(ctx, "reddit", reddit.config));
    await browserHandler.remove!(ctx, "reddit", reddit.config);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
    expect(await browserHandler.status(ctx, "reddit", reddit.config)).toEqual({ state: "inactive" });
});

test("every contributed platform has a real login URL and a skill that leaves room for the core tools note", async () => {
    const registry = await contributionRegistry(host);
    const browsers = [...registry.values()].filter((entry) => entry.spec.kind === "browser");
    expect(browsers.length).toBeGreaterThan(0);
    for (const { spec } of browsers) {
        if (spec.kind !== "browser") {
            continue;
        }
        expect(spec.loginUrl, spec.id).toMatch(/^https:\/\//);
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

test("echoConfig exposes only the platform; browser holds no manifest secret", () => {
    expect(echoConfig(reddit, new Map())).toEqual({ platform: "reddit" });
    expect(secretField(reddit, new Map())).toBeUndefined();
});
