import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { fileSecretVault } from "../capabilities/secret-vault.js";
import { secretValuesOf } from "./secret-values.js";

/* WHAT THE MASKING IS GIVEN TO BLANK. The product stores secrets in two places that both reach the agent's
 * environment — the capability vault and the DevOps `.env` — so a list built from one of them would mask a
 * connector's token and hand a deploy key straight to the model. These pin that the list is the union, and
 * that neither store failing takes the other's values down with it. */

const withStores = () => {
    const root = mkdtempSync(join(tmpdir(), "secret-values-"));
    const repo = join(root, "desired-state");
    const vault = fileSecretVault(join(root, "auth", "capability-secrets.json"));
    const writeEnv = async (body: string): Promise<void> => {
        await mkdir(repo, { recursive: true });
        await writeFile(join(repo, ENV_FILE), body);
    };
    return { vault, writeEnv, values: secretValuesOf(vault, () => repo) };
};

test("the list is the union of both stores", async () => {
    const { vault, writeEnv, values } = withStores();
    await vault.set("reddit", { password: "Xk4!mQ2pRt7@wZ9aBc1_" });
    await writeEnv("CLOUDFLARE_API_TOKEN=cf_live_0011223344ff\n");
    expect((await values()).toSorted()).toEqual(["Xk4!mQ2pRt7@wZ9aBc1_", "cf_live_0011223344ff"]);
});

test("VALUES only, never key names", async () => {
    // A key name is not a secret, and masking it would blank ordinary prose — a file that merely mentions
    // GITHUB_TOKEN is documentation, not a leak.
    const { writeEnv, values } = withStores();
    await writeEnv("GITHUB_TOKEN=ghp_0011223344ff5566\n");
    expect(await values()).toEqual(["ghp_0011223344ff5566"]);
});

test("a missing .env leaves the vault's values intact", async () => {
    // The ordinary case for a sandbox that has never used the deploy engine.
    const { vault, values } = withStores();
    await vault.set("linear", { token: "mcp_tok_9f2b1c7e4a0d" });
    expect(await values()).toEqual(["mcp_tok_9f2b1c7e4a0d"]);
});

test("an unreadable vault still yields the .env's values", async () => {
    // Neither store may take the other down: masking only half the credentials is the failure this guards.
    const root = mkdtempSync(join(tmpdir(), "secret-values-"));
    const repo = join(root, "desired-state");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, ENV_FILE), "CLOUDFLARE_API_TOKEN=cf_live_0011223344ff\n");
    const broken = secretValuesOf(
        {
            get: async () => ({}),
            all: async () => ({}),
            set: async () => {},
            remove: async () => {},
            values: async () => {
                throw new Error("EACCES");
            },
        },
        () => repo,
    );
    expect(await broken()).toEqual(["cf_live_0011223344ff"]);
});

test("nothing stored anywhere is an empty list, not a throw", async () => {
    const { values } = withStores();
    expect(await values()).toEqual([]);
});

test("a credential connected mid-turn is masked in the very next tool result", async () => {
    // Read on each call rather than cached — the window between connecting a service and the next tool result
    // is exactly where a cache would leak.
    const { vault, values } = withStores();
    expect(await values()).toEqual([]);
    await vault.set("reddit", { password: "Xk4!mQ2pRt7@wZ9aBc1_" });
    expect(await values()).toEqual(["Xk4!mQ2pRt7@wZ9aBc1_"]);
});
