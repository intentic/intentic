import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { type Capability, PhoneScopesSchema } from "@intentic/sandbox-contract";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { contributionRegistry } from "../contributions.js";
import { echoConfig, secretField } from "../summary.js";
import { phoneHandler } from "./phone.handler.js";

// The real first-party `phones` extension provides the Android pack; the tool surface it wraps is core.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// A ctx exposing only what phoneHandler touches, with the enrollment, socket and wake channel each set by the test.
const tempCtx = (state: { enrolled?: boolean; online?: boolean; wake?: "ready" | "register" | "none" } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "phone-cap-"));
    const forgotten: string[] = [];
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        capabilities: { list: async () => [] },
        extensionsDir: EXTENSIONS_DIR,
        historyRoot: mkdtempSync(join(tmpdir(), "cap-history-")),
        phones: { enrolled: async () => state.enrolled === true, revokeCard: async (id: string) => [id], relabelCard: async () => [] },
        phoneHub: {
            online: () => state.online === true,
            state: () => ({ online: state.online === true }),
            pushScopes: async () => state.online === true,
            disconnect: () => {},
        },
        phoneWake: { state: async () => state.wake ?? "none", forget: async (id: string) => void forgotten.push(id), rekey: async () => {} },
    } as unknown as CapabilityCtx;
    return { ctx, root, forgotten };
};

const host: ExtensionHost = {
    workspace: { root: WORKSPACE_ROOT },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => [] },
    config: { extensionsDir: EXTENSIONS_DIR, historyRoot: mkdtempSync(join(tmpdir(), "cap-history-")) },
} as unknown as ExtensionHost;

const pixel: Capability = { id: "my-pixel", kind: "phone", config: { ...PhoneScopesSchema.parse({}), platform: "android" } };
const skillPath = (root: string): string => join(root, ".agents", "skills", "my-pixel", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply installs the contributed Android pack with the core tools note and this phone's name", async () => {
    const { ctx, root } = tempCtx();
    expect(await phoneHandler.status(ctx, "my-pixel", pixel.config)).toEqual({ state: "inactive" });
    await drain(phoneHandler.apply(ctx, "my-pixel", pixel.config));
    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toMatch(/Android specifics/i);
    expect(skill).toContain("mcp__my-pixel__ui_elements");
    expect(skill).toContain("name: my-pixel");
    expect(skill).not.toContain("${tools}");
    expect(skill).not.toContain("${id}");
    expect(await phoneHandler.status(ctx, "my-pixel", pixel.config)).toEqual({
        state: "pending",
        detail: "click Connect and scan the code with that phone's camera",
    });
});

test("a paired phone reads active when it is connected or the sandbox can wake it, and away when it cannot", async () => {
    for (const [state, expected] of [
        [{ enrolled: true, online: true }, { state: "active" }],
        [
            { enrolled: true, wake: "ready" as const },
            { state: "active", detail: "asleep; the agent's first call wakes it" },
        ],
        [
            { enrolled: true, wake: "register" as const },
            { state: "pending", detail: "asleep; the agent's first call wakes it" },
        ],
    ] as const) {
        const { ctx } = tempCtx(state);
        await drain(phoneHandler.apply(ctx, "my-pixel", pixel.config));
        expect(await phoneHandler.status(ctx, "my-pixel", pixel.config)).toEqual(expected);
    }
});

test("removing a phone revokes it and forgets the channel that could wake it", async () => {
    const { ctx, forgotten } = tempCtx({ enrolled: true });
    await drain(phoneHandler.apply(ctx, "my-pixel", pixel.config));
    await phoneHandler.remove?.(ctx, "my-pixel", pixel.config);
    expect(forgotten).toEqual(["my-pixel"]);
});

test("the one contributed phone family names where its app comes from", async () => {
    const registry = await contributionRegistry(host);
    const entries = [...registry.values()].filter((entry) => entry.spec.kind === "phone");
    expect(entries.map((entry) => entry.spec.id)).toEqual(["android"]);
    expect(entries[0]?.spec.kind === "phone" && entries[0].spec.install).toBe("https://intentic.dev/phone");
});

test("echoConfig renders every switch back and a phone holds no manifest secret", () => {
    expect(echoConfig(pixel, new Map())).toEqual({
        platform: "android",
        screen: "on",
        control: "off",
        files: "on",
        write: "off",
        notifications: "off",
        apps: "on",
        destructive: "off",
        confirm: "sensitive",
    });
    expect(secretField(pixel, new Map())).toBeUndefined();
});
