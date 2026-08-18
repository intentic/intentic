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
import { readWorkspaceFile } from "../workspace/workspace-files.js";
import { extensionEnvOf } from "./extension-env.js";
import { writeExtensionSettings } from "./extension-settings.js";

/* A vault of its own per test, off the workspace root exactly as production sites it (under AGENT_AUTH_DIR).
 *
 * It is what makes these two tests worth more than they used to be. A `secret: true` setting's value no longer
 * sits in the settings file — that file is tracked in the root repo now, which is only safe because the value
 * left it — so the env var these assert on is the whole round trip: written through the split, read back through
 * the rehydration, and only then handed to the agent's shell. A split that quietly stopped feeding `env` would
 * take a working connector's credential away from its CLI with nothing failing. */
const newVault = (): SecretVault => fileSecretVault(join(mkdtempSync(join(tmpdir(), "ext-vault-")), "extension-secrets.json"));

// A Services stub exposing only what extensionEnvOf touches: the capability list, files.read, workspace.root,
// the settings vault, and a no-op logger.
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

    // The split happened on the way in: the tracked file kept the open settings, the vault took the credential.
    expect(await vault.get("acme.tap")).toEqual({ token: "s3cr3t" });
    expect(JSON.parse(await readFile(join(root, ".intentic/extension-settings.json"), "utf8"))).toEqual({
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
