import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import { testConfig } from "../testing.js";
import { extensionDir } from "../capabilities/extension-dirs.js";
import { fileSecretVault, type SecretVault } from "../capabilities/secret-vault.js";
import { readWorkspaceFile } from "../workspace/files/workspace-files.js";
import { extensionEnvOf } from "./extension-env.js";
import { writeExtensionSettings } from "./extension-settings.js";

// Vault sits off the workspace root under AGENT_AUTH_DIR, matching production.
// Tests assert the round trip a secret setting takes: split out, rehydrated, then handed to the shell as env.
const newVault = (): SecretVault => fileSecretVault(join(mkdtempSync(join(tmpdir(), "ext-vault-")), "extension-secrets.json"));

// Services stub exposing only what extensionEnvOf touches: capabilities, files.read, workspace.root, the settings
// vault, a no-op logger.
const stubServices = (root: string, vault: SecretVault, capabilities: Capability[]): Services =>
    unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => capabilities }),
        config: { ...testConfig, extensionsDir: "" },
        extensionSecretVault: vault,
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
    const vault = newVault();
    await writeExtensionSettings(root, vault, "acme.tap", { token: "s3cr3t", region: "eu", verbose: true }, new Set(["token"]));

    expect(await vault.get("acme.tap")).toEqual({ token: "s3cr3t" });
    expect(JSON.parse(await readFile(join(root, ".intentic/config/extension-settings.json"), "utf8"))).toEqual({
        "acme.tap": { region: "eu", verbose: true },
    });

    const env = await extensionEnvOf(
        stubServices(root, vault, [{ id: "acme.tap", kind: "extension", config: { url: "https://x/y.git", ref: "a".repeat(40) } }]),
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
    const vault = newVault();
    await writeExtensionSettings(root, vault, "acme.tap", { token: "" }, new Set(["token"]));

    const env = await extensionEnvOf(
        stubServices(root, vault, [{ id: "acme.tap", kind: "extension", config: { url: "https://x/y.git", ref: "a".repeat(40) } }]),
    );
    expect(env).toEqual({});
});
