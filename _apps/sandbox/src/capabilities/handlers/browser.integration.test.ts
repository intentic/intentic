import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { browserProviders } from "../../browser/providers.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig, secretField } from "../summary.js";
import { browserHandler } from "./browser.js";

// A ctx exposing only what browserHandler touches (files + workspace.root), over a fresh temp workspace.
const tempCtx = (): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "browser-cap-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

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

test("every platform has a non-empty skill with front-matter", () => {
    for (const [platform, provider] of Object.entries(browserProviders)) {
        expect(provider.skill, platform).toContain(`name: ${platform}`);
        expect(provider.skill.length).toBeGreaterThan(100);
        expect(provider.loginUrl, platform).toMatch(/^https:\/\//);
    }
});

test("echoConfig exposes only the platform; browser holds no manifest secret", () => {
    expect(echoConfig(reddit, new Map())).toEqual({ platform: "reddit" });
    expect(secretField(reddit, new Map())).toBeUndefined();
});
