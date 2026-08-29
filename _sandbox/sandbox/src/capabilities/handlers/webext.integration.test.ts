import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { contributionRegistry } from "../contributions.js";
import { echoConfig, secretField } from "../summary.js";
import { webextHandler } from "./webext.js";

// The real first-party `browsers` extension provides each family's pack; the tool surface it wraps is core.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// A ctx exposing only what webextHandler touches. The browser is never paired here, which is the pre-Connect
// state every add starts in: pairing one needs a person pasting a code into a real extension.
const tempCtx = (): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "webext-cap-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => [] },
        extensionsDir: EXTENSIONS_DIR,
        webexts: { enrolled: async () => false },
        webextHub: { online: () => false },
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

const host: ExtensionHost = {
    workspace: { root: WORKSPACE_ROOT },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => [] },
    config: { extensionsDir: EXTENSIONS_DIR },
} as unknown as ExtensionHost;

const chrome: Capability = {
    id: "my-chrome",
    kind: "webext",
    config: { platform: "chrome", read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" },
};
const skillPath = (root: string): string => join(root, ".agents", "skills", "my-chrome", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply installs the contributed browser pack with the core tools note and this instance's name", async () => {
    const { ctx, root } = tempCtx();
    expect(await webextHandler.status(ctx, "my-chrome", chrome.config)).toEqual({ state: "inactive" });

    await drain(webextHandler.apply(ctx, "my-chrome", chrome.config));

    const skill = await readWorkspaceFile(skillPath(root));
    // The pack is the family half; `${tools}` is the core half, and `${id}` makes the tool names this browser's.
    expect(skill).toContain("Chromium specifics worth knowing");
    expect(skill).toContain("mcp__my-chrome__snapshot");
    expect(skill).toContain("name: my-chrome");
    expect(skill).not.toContain("${tools}");
    expect(skill).not.toContain("${id}");
    // Added but never paired: the reader's next action is pasting the code into the extension, and the card says so.
    expect(await webextHandler.status(ctx, "my-chrome", chrome.config)).toEqual({
        state: "pending",
        detail: "click Connect and paste the code into the extension",
    });
});

test("a browser family with no installed pack is refused rather than writing an empty skill", async () => {
    const { ctx, root } = tempCtx();
    await expect(drain(webextHandler.apply(ctx, "my-chrome", { ...chrome.config, platform: "netscape" }))).rejects.toThrow(/netscape/);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
});

test("every contributed browser card names a family and where its extension is installed from", async () => {
    const registry = await contributionRegistry(host);
    const cards = [...registry.values()].filter((entry) => entry.spec.kind === "webext");
    expect(cards.map((entry) => entry.spec.id).toSorted()).toEqual(["chrome", "edge"]);
    for (const card of cards) {
        // The one thing the families genuinely differ in, and what the connect dialog links to.
        expect(card.spec.kind === "webext" && card.spec.install).toMatch(/^https:\/\//);
    }
});

test("echoConfig renders the grant back and webext holds no manifest secret", () => {
    // Every field is a permission and none is a credential: the enrollment token lives on /history, so rotating
    // it is re-pairing in the browser, not an edit in /secrets.
    expect(echoConfig(chrome, new Map())).toEqual({
        platform: "chrome",
        read: "on",
        act: "on",
        screenshot: "off",
        cookies: "off",
        confirm: "sensitive",
    });
    expect(secretField(chrome, new Map())).toBeUndefined();
});
