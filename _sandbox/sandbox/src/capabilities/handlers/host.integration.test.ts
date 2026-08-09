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
import { hostHandler } from "./host.js";

// The real first-party `computers` extension provides each OS pack; the tool surface it wraps is core.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// A ctx exposing only what hostHandler touches. The machine is never enrolled here, which is the pre-Connect
// state every add starts in — enrolling one needs a real socket from a real computer.
const tempCtx = (): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "host-cap-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => [] },
        extensionsDir: EXTENSIONS_DIR,
        hosts: { enrolled: async () => false },
        hostHub: { online: () => false },
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

const host: ExtensionHost = {
    workspace: { root: WORKSPACE_ROOT },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => [] },
    config: { extensionsDir: EXTENSIONS_DIR },
} as unknown as ExtensionHost;

const laptop: Capability = {
    id: "my-laptop",
    kind: "host",
    config: { platform: "windows", shell: "on", write: "off", screen: "on", control: "off", sandboxes: "off", sandboxRemove: "off" },
};
const skillPath = (root: string): string => join(root, ".claude", "skills", "my-laptop", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply installs the contributed OS pack with the core tools note and this instance's name", async () => {
    const { ctx, root } = tempCtx();
    expect(await hostHandler.status(ctx, "my-laptop", laptop.config)).toEqual({ state: "inactive" });

    await drain(hostHandler.apply(ctx, "my-laptop", laptop.config));

    const skill = await readWorkspaceFile(skillPath(root));
    // The pack is the OS half (PowerShell here); `${tools}` is the core half, and `${id}` makes the tool names
    // this machine's, so the examples are copy-pasteable rather than illustrative.
    expect(skill).toContain("This machine runs Windows");
    expect(skill).toContain("mcp__my-laptop__run_command");
    expect(skill).toContain("name: my-laptop");
    expect(skill).not.toContain("${tools}");
    expect(skill).not.toContain("${id}");
    // Added but never connected — the user's next action is running the one-liner over there, and the card says so.
    expect(await hostHandler.status(ctx, "my-laptop", laptop.config)).toEqual({
        state: "pending",
        detail: "click Connect and run the one-liner on that computer",
    });
});

test("an OS with no installed pack is refused rather than writing an empty skill", async () => {
    const { ctx, root } = tempCtx();
    await expect(drain(hostHandler.apply(ctx, "my-laptop", { ...laptop.config, platform: "plan9" }))).rejects.toThrow(/plan9/);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
});

test("every contributed OS pack carries both halves' placeholders", async () => {
    const registry = await contributionRegistry(host);
    const packs = [...registry.values()].filter((entry) => entry.spec.kind === "host");
    expect(packs.map((entry) => entry.spec.id).toSorted()).toEqual(["linux", "windows"]);
});

test("echoConfig renders the grant back and host holds no manifest secret", () => {
    // Every field is a permission and none is a credential: the enrollment token lives on /history, so rotating
    // it is re-running the installer, not an edit in /secrets.
    expect(echoConfig(laptop, new Map())).toEqual({
        platform: "windows",
        shell: "on",
        write: "off",
        screen: "on",
        control: "off",
        sandboxes: "off",
        sandboxRemove: "off",
    });
    expect(secretField(laptop, new Map())).toBeUndefined();
});
