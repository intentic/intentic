import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "@intentic/scaffold";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { createTerminalRunner, terminalExec } from "../../system/terminal-run.js";
import { makeWorkspaceDir, readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig } from "../capability.js";
import { cliEnvOf } from "../cli-env.js";
import { connectorRegistry } from "../cli/connector-registry.js";
import { type GitAccessDeps, gitHostOf, setupGitAccess, teardownGitAccess } from "../cli/git-access.js";
import { cliHandler } from "./cli.js";

// The real first-party connectors/discord extensions provide every provider's data (fields/env/skill/fragment).
const EXTENSIONS_DIR = fileURLToPath(new URL("../../../../../_extensions", import.meta.url));

// A ctx exposing only what cliHandler touches (files + workspace.root + capabilities + extensionsDir + the
// terminal runner in its no-tmux fallback), over a fresh temp workspace. HOME is a temp dir so the github/gitlab
// git-access hook never touches the real home.
const tempCtx = (capabilities: Capability[] = []): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "cli-cap-"));
    process.env.HOME = mkdtempSync(join(tmpdir(), "cli-cap-home-"));
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath, mkdir: makeWorkspaceDir },
        capabilities: { list: async () => capabilities },
        extensionsDir: EXTENSIONS_DIR,
        terminalRun: createTerminalRunner(),
    } as unknown as CapabilityCtx;
    return { ctx, root };
};

const hostFor = (capabilities: Capability[]): ExtensionHost =>
    ({
        workspace: { root: "/work" },
        files: { read: readWorkspaceFile },
        capabilities: { list: async () => capabilities },
        config: { extensionsDir: EXTENSIONS_DIR },
    }) as unknown as ExtensionHost;

const discord: Capability = { id: "discord", kind: "cli", config: { provider: "discord", botToken: "tok-123" } };
const skillPath = (root: string, id: string): string => join(root, ".claude", "skills", id, "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply writes the connector's SKILL.md; discord stays pending until whisper is rebuilt in", async () => {
    const { ctx, root } = tempCtx();
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "inactive" });

    await drain(cliHandler.apply(ctx, "discord", discord.config));

    const skill = await readWorkspaceFile(skillPath(root, "discord"));
    expect(skill).toContain("name: discord");
    expect(skill).toContain("$DISCORD_BOT_TOKEN");
    expect(skill).toContain("https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1117248");
    expect(skill).toContain("join_voice");
    expect(skill).not.toContain("FROM registry.gitlab.com");
    // whisper-cli isn't installed in test envs — voice pends on the owner's rebuild.
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "pending", detail: "voice needs a rebuild (whisper)" });
});

test("a provider without image needs (github) goes straight to active", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh", git: "off" } };
    const { ctx } = tempCtx();
    await drain(cliHandler.apply(ctx, "github", github.config));
    expect(await cliHandler.status(ctx, "github", github.config)).toEqual({ state: "active" });
});

test("apply rejects an unknown provider and a config missing a required field", async () => {
    const { ctx } = tempCtx();
    await expect(drain(cliHandler.apply(ctx, "x", { provider: "nope" }))).rejects.toThrow(/no connector for provider/);
    await expect(drain(cliHandler.apply(ctx, "gh", { provider: "github" }))).rejects.toThrow(/requires "token"/);
});

test("remove deletes the skill dir; status returns to inactive", async () => {
    const { ctx, root } = tempCtx();
    await drain(cliHandler.apply(ctx, "discord", discord.config));
    await cliHandler.remove!(ctx, "discord", discord.config);
    expect(await readWorkspaceFile(skillPath(root, "discord"))).toBeUndefined();
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "inactive" });
});

test("apply templates the SKILL.md for the instance: unique name + suffixed vars", async () => {
    const { ctx, root } = tempCtx();
    const postgres: Capability = {
        id: "analytics",
        kind: "cli",
        config: { provider: "postgres", host: "pg.example.com", port: "5432", user: "app", password: "pw", database: "shop" },
    };
    await drain(cliHandler.apply(ctx, "analytics", postgres.config));
    const skill = await readWorkspaceFile(skillPath(root, "analytics"));
    expect(skill).toContain("name: analytics");
    expect(skill).toContain("$POSTGRES_URL_ANALYTICS");
    expect(skill).not.toContain("name: postgres");
});

test("cliEnvOf suffixes each var with the instance id; ignores non-cli capabilities", async () => {
    const mcp: Capability = { id: "x", kind: "mcp", config: { url: "https://a/mcp" } };
    expect(await cliEnvOf(hostFor([discord, mcp]))).toEqual({ DISCORD_BOT_TOKEN_DISCORD: "tok-123" });
    expect(await cliEnvOf(hostFor([mcp]))).toEqual({});
});

test("cliEnvOf expands each connector's env template; two instances of one provider don't collide", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh" } };
    const gitlab: Capability = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl", url: "https://gitlab.example.com" } };
    const imap: Capability = {
        id: "imap",
        kind: "cli",
        config: { provider: "imap", host: "imap.example.com", port: "993", username: "u@e.com", password: "pw" },
    };
    const primary: Capability = {
        id: "analytics",
        kind: "cli",
        config: { provider: "postgres", host: "a.example.com", port: "5432", user: "app", password: "pw1", database: "metrics" },
    };
    const secondary: Capability = {
        id: "billing",
        kind: "cli",
        config: { provider: "postgres", host: "b.example.com", port: "5432", user: "app", password: "pw2", database: "invoices" },
    };
    expect(await cliEnvOf(hostFor([github]))).toEqual({ GITHUB_TOKEN_GITHUB: "gh" });
    expect(await cliEnvOf(hostFor([gitlab]))).toEqual({ GITLAB_TOKEN_GITLAB: "gl", GITLAB_URL_GITLAB: "https://gitlab.example.com" });
    expect(await cliEnvOf(hostFor([imap]))).toEqual({
        IMAP_HOST_IMAP: "imap.example.com",
        IMAP_PORT_IMAP: "993",
        IMAP_USERNAME_IMAP: "u@e.com",
        IMAP_PASSWORD_IMAP: "pw",
    });
    // The postgres URL template percent-encodes user/password/database (${field:uri}).
    expect(await cliEnvOf(hostFor([primary, secondary]))).toEqual({
        POSTGRES_URL_ANALYTICS: "postgresql://app:pw1@a.example.com:5432/metrics",
        POSTGRES_URL_BILLING: "postgresql://app:pw2@b.example.com:5432/invoices",
    });
});

test("echoConfig never leaks the secret — the token becomes hasSecret", async () => {
    const connectors = await connectorRegistry(hostFor([]));
    expect(echoConfig(discord, connectors)).toEqual({ provider: "discord", hasSecret: true });
    const gitlab: Capability = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl", url: "https://gitlab.com" } };
    // Non-secret fields (provider, url) echo; the secret token becomes hasSecret and never its value.
    expect(echoConfig(gitlab, connectors)).toEqual({ provider: "gitlab", url: "https://gitlab.com", hasSecret: true });
});

// ---- git access (github/gitlab clone/pull/push in the terminal) ----
// The account-key REST calls are the injectable seam; keygen + git-config run for real against a temp HOME,
// through the terminal-exec adapter in its no-tmux fallback (the same path cliHandler wires in production).

const execInTerminal = terminalExec(createTerminalRunner(), "git-cap-test", tmpdir());

const gitHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), "git-cap-home-"));
    process.env.HOME = home;
    return home;
};
const hostKey = (home: string, host: string): string => join(home, ".ssh", "intentic-hosts", `${host}.key`);
const hostConf = (home: string, host: string): string => join(home, ".ssh", "intentic-hosts", `${host}.conf`);
const httpsRewrite = async (host: string): Promise<string[]> => {
    const { stdout } = await exec("git", ["config", "--global", "--get-all", `url.https://${host}/.insteadOf`]).catch(() => ({ stdout: "" }));
    return stdout.split("\n").filter((line) => line.trim() !== "");
};

test("git setup: writes a 0600 key + ssh alias + https creds, registers the public half, and returns no warning", async () => {
    const home = gitHome();
    const uploads: { publicKey: string; title: string }[] = [];
    const deps: GitAccessDeps = { uploadKey: async (_host, publicKey, title) => void uploads.push({ publicKey, title }), deleteKey: async () => {} };
    const host = gitHostOf({ provider: "github", token: "gh-tok", git: "on" });

    expect(await setupGitAccess(host, execInTerminal, deps)).toBeUndefined();

    expect(statSync(hostKey(home, "github.com")).mode & 0o777).toBe(0o600);
    const conf = readFileSync(hostConf(home, "github.com"), "utf8");
    expect(conf).toContain("Host github.com");
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).toContain("https://x-access-token:gh-tok@github.com");
    const publicKey = readFileSync(`${hostKey(home, "github.com")}.pub`, "utf8").trim();
    expect(uploads).toEqual([{ publicKey, title: "intentic-sandbox" }]);
    expect(await httpsRewrite("github.com")).toEqual([]);
});

test("git setup reroutes ssh over https + warns (no throw) when ssh-key registration is refused", async () => {
    const home = gitHome();
    const deps: GitAccessDeps = {
        uploadKey: async () => {
            throw new Error("GitHub SSH key upload failed (404): Not Found");
        },
        deleteKey: async () => {},
    };
    const host = gitHostOf({ provider: "github", token: "scopeless", git: "on" });

    const warning = await setupGitAccess(host, execInTerminal, deps);

    const publicKey = readFileSync(`${hostKey(home, "github.com")}.pub`, "utf8").trim();
    expect(warning).toContain("write:public_key");
    expect(warning).toContain(publicKey);
    expect(existsSync(hostConf(home, "github.com"))).toBe(false);
    expect(await httpsRewrite("github.com")).toEqual(["git@github.com:", "ssh://git@github.com/"]);
});

test("git setup (gitlab): host + https user derive from the instance url", async () => {
    const home = gitHome();
    const deps: GitAccessDeps = { uploadKey: async () => {}, deleteKey: async () => {} };
    const host = gitHostOf({ provider: "gitlab", token: "gl-tok", url: "https://gitlab.example.com", git: "on" });

    await setupGitAccess(host, execInTerminal, deps);

    expect(existsSync(hostConf(home, "gitlab.example.com"))).toBe(true);
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).toContain("https://oauth2:gl-tok@gitlab.example.com");
});

test("git teardown: deletes the account key and removes the local key, ssh alias and https line", async () => {
    const home = gitHome();
    let deleted = 0;
    const deps: GitAccessDeps = { uploadKey: async () => {}, deleteKey: async () => void (deleted += 1) };
    const host = gitHostOf({ provider: "github", token: "gh-tok", git: "on" });
    await setupGitAccess(host, execInTerminal, deps);

    await teardownGitAccess(host, execInTerminal, deps);

    expect(deleted).toBe(1);
    expect(existsSync(hostKey(home, "github.com"))).toBe(false);
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).not.toContain("github.com");
});

test("git teardown is a no-op (no account call) when nothing was ever set up", async () => {
    gitHome();
    let deleted = 0;
    const deps: GitAccessDeps = { uploadKey: async () => {}, deleteKey: async () => void (deleted += 1) };
    await teardownGitAccess(gitHostOf({ provider: "github", token: "x", git: "off" }), execInTerminal, deps);
    expect(deleted).toBe(0);
});
