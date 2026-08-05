import { parseEnv } from "node:util";
import { expect, test } from "vitest";
import { envKeys, removeEnv, upsertEnv } from "./secrets.routes.js";

test("upsertEnv appends a new key, updates an existing one, and leaves the rest untouched", () => {
    let env = upsertEnv("", "CLOUDFLARE_API_TOKEN", "cf1");
    expect(env).toBe('CLOUDFLARE_API_TOKEN="cf1"\n');
    env = upsertEnv(env, "GITHUB_TOKEN", "gh1");
    expect(env).toBe('CLOUDFLARE_API_TOKEN="cf1"\nGITHUB_TOKEN="gh1"\n');
    // Re-setting an existing key edits it in place (no duplicate line).
    env = upsertEnv(env, "CLOUDFLARE_API_TOKEN", "cf2");
    expect(env).toBe('CLOUDFLARE_API_TOKEN="cf2"\nGITHUB_TOKEN="gh1"\n');
});

test("upsertEnv round-trips a multi-line value (SSH private key) without corrupting later keys", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA==\n-----END OPENSSH PRIVATE KEY-----";
    let env = upsertEnv("", "PROD_SSH_KEY", pem);
    env = upsertEnv(env, "CLOUDFLARE_API_TOKEN", "cf1");
    const parsed = parseEnv(env);
    expect(parsed["PROD_SSH_KEY"]).toBe(pem);
    expect(parsed["CLOUDFLARE_API_TOKEN"]).toBe("cf1");
    // Updating the multi-line entry keeps the file parseable and the other key intact.
    env = upsertEnv(env, "PROD_SSH_KEY", `${pem}2`);
    expect(parseEnv(env)).toEqual({ PROD_SSH_KEY: `${pem}2`, CLOUDFLARE_API_TOKEN: "cf1" });
});

test("envKeys returns keys only (never values), skipping blanks and comments", () => {
    expect(envKeys("# a comment\nCLOUDFLARE_API_TOKEN=secret\n\nPROD_SSH_KEY=----\n")).toEqual(["CLOUDFLARE_API_TOKEN", "PROD_SSH_KEY"]);
});

test("removeEnv drops exactly the named key and is a no-op for an absent one", () => {
    const env = 'CLOUDFLARE_API_TOKEN="cf1"\nGITHUB_TOKEN="gh1"\n';
    expect(removeEnv(env, "CLOUDFLARE_API_TOKEN")).toBe('GITHUB_TOKEN="gh1"\n');
    expect(removeEnv(env, "GHOST")).toBe(env);
});
