import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { testConfig, unstubbed } from "../testing.js";
import { extensionDir } from "../capabilities/extension-dirs.js";
import { readWorkspaceFile } from "../workspace/workspace-files.js";
import { extensionEnvOf } from "./extension-env.js";
import { writeExtensionSettings } from "./extension-settings.js";

// A Services stub exposing only what extensionEnvOf touches: the capability list, files.read, workspace.root,
// and a no-op logger.
const stubServices = (root: string, capabilities: Capability[]): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        config: { ...testConfig, extensionsDir: "" },
        logger: unstubbed<Services["logger"]>("logger", { warn: () => undefined }),
    });

const installExtension = async (root: string, id: string, manifest: object): Promise<void> => {
    const dir = extensionDir(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "intentic-extension.json"), JSON.stringify(manifest));
};

test("injects the env var for a set secret setting, skips unset and non-env settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-env-"));
    await installExtension(root, "acme.tap", {
        publisher: "acme",
        name: "tap",
        version: "1.0.0",
        engines: { intentic: "^0.2.0" },
        contributes: {
            settings: [
                { key: "token", type: "string", title: "Token", secret: true, env: "ACME_TOKEN" },
                { key: "region", type: "string", title: "Region", env: "ACME_REGION" },
                { key: "verbose", type: "boolean", title: "Verbose" },
            ],
        },
    });
    await writeExtensionSettings(root, "acme.tap", { token: "s3cr3t", region: "eu", verbose: true });

    const env = await extensionEnvOf(
        stubServices(root, [{ id: "acme.tap", kind: "extension", config: { url: "https://x/y.git", ref: "a".repeat(40) } }]),
    );
    expect(env).toEqual({ ACME_TOKEN: "s3cr3t", ACME_REGION: "eu" });
});

test("an empty secret contributes no env var (cleared)", async () => {
    const root = mkdtempSync(join(tmpdir(), "ext-env-"));
    await installExtension(root, "acme.tap", {
        publisher: "acme",
        name: "tap",
        version: "1.0.0",
        engines: { intentic: "^0.2.0" },
        contributes: { settings: [{ key: "token", type: "string", title: "Token", secret: true, env: "ACME_TOKEN" }] },
    });
    await writeExtensionSettings(root, "acme.tap", { token: "" });

    const env = await extensionEnvOf(
        stubServices(root, [{ id: "acme.tap", kind: "extension", config: { url: "https://x/y.git", ref: "a".repeat(40) } }]),
    );
    expect(env).toEqual({});
});
