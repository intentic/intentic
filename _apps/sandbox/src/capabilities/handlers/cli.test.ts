import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "@intentic/scaffold";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { createTerminalRunner, terminalExec } from "../../system/terminal-run.js";
import { readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig } from "../capability.js";
import { cliEnvOf } from "../cli-env.js";
import { type GitAccessDeps, gitHostOf, setupGitAccess, teardownGitAccess } from "../cli/git-access.js";
import { cliProviders } from "../cli/providers.js";
import { cliHandler } from "./cli.js";

// A ctx exposing only what cliHandler touches (files + workspace.root + the terminal runner, which the tests
// get as the real no-tmux fallback — commands run as plain bash), over a fresh temp workspace. HOME is
// pointed at a temp dir too: applying a github/gitlab cli runs the git-access hook, whose git-off branch probes
// ~/.ssh — a temp HOME keeps every test off the real home.
const tempCtx = (): { ctx: CapabilityCtx; root: string; home: string } => {
    const root = mkdtempSync(join(tmpdir(), "cli-cap-"));
    const home = mkdtempSync(join(tmpdir(), "cli-cap-home-"));
    process.env.HOME = home;
    const ctx = {
        workspace: { root },
        files: { write: writeWorkspaceFile, read: readWorkspaceFile, remove: removeWorkspacePath },
        terminalRun: createTerminalRunner(),
    } as unknown as CapabilityCtx;
    return { ctx, root, home };
};

const discord: Capability = { id: "discord", kind: "cli", config: { provider: "discord", botToken: "tok-123" } };
const skillPath = (root: string): string => join(root, ".claude", "skills", "discord", "SKILL.md");

const drain = async (gen: AsyncGenerator<unknown>): Promise<void> => {
    for await (const _ of gen) {
        // consume the apply frames
    }
};

test("apply writes the provider's SKILL.md; discord stays pending until whisper is rebuilt in", async () => {
    const { ctx, root } = tempCtx();
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "inactive" });

    await drain(cliHandler.apply(ctx, "discord", discord.config));

    const skill = await readWorkspaceFile(skillPath(root));
    expect(skill).toContain("name: discord");
    expect(skill).toContain("$DISCORD_BOT_TOKEN");
    expect(skill).toContain("https://discord.com/api/v10/channels/<CHANNEL_ID>/messages");
    // The guided-invite section (permissions include Connect for voice), the react example, and the voice tools.
    expect(skill).toContain("https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1117248");
    expect(skill).toContain("/reactions/");
    expect(skill).toContain("join_voice");
    // The whisper recipe lives in the capability's fragment now, not as re-typable skill prose.
    expect(skill).toContain("Environment card");
    expect(skill).not.toContain("FROM registry.gitlab.com");
    // whisper-cli isn't installed in test envs — voice pends on the owner's rebuild.
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "pending", detail: "voice needs a rebuild (whisper)" });
});

test("a provider without image needs (github) goes straight to active; only discord carries the whisper fragment", async () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh" } };
    const { ctx } = tempCtx();
    await drain(cliHandler.apply(ctx, "github", github.config));
    expect(await cliHandler.status(ctx, "github", github.config)).toEqual({ state: "active" });
    expect(cliHandler.fragment!(github.config)).toBeUndefined();
    expect(cliHandler.fragment!(discord.config)).toContain("whisper-cli");
});

test("remove deletes the skill dir; status returns to inactive", async () => {
    const { ctx, root } = tempCtx();
    await drain(cliHandler.apply(ctx, "discord", discord.config));
    await cliHandler.remove!(ctx, "discord", discord.config);
    expect(await readWorkspaceFile(skillPath(root))).toBeUndefined();
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "inactive" });
});

test("cliEnvOf suffixes each var with the instance id; ignores non-cli capabilities", () => {
    const mcp: Capability = { id: "x", kind: "mcp", config: { url: "https://a/mcp" } };
    expect(cliEnvOf([discord, mcp])).toEqual({ DISCORD_BOT_TOKEN_DISCORD: "tok-123" });
    expect(cliEnvOf([mcp])).toEqual({});
});

test("two instances of one provider don't collide — each keeps its own suffixed vars", () => {
    const primary: Capability = {
        id: "analytics",
        kind: "cli",
        config: { provider: "postgres", host: "a.example.com", port: 5432, user: "app", password: "pw1", database: "metrics" },
    };
    const secondary: Capability = {
        id: "billing",
        kind: "cli",
        config: { provider: "postgres", host: "b.example.com", port: 5432, user: "app", password: "pw2", database: "invoices" },
    };
    expect(cliEnvOf([primary, secondary])).toEqual({
        POSTGRES_URL_ANALYTICS: "postgresql://app:pw1@a.example.com:5432/metrics",
        POSTGRES_URL_BILLING: "postgresql://app:pw2@b.example.com:5432/invoices",
    });
});

test("apply templates the SKILL.md for the instance: unique name + suffixed vars", async () => {
    const { ctx, root } = tempCtx();
    const postgres: Capability = {
        id: "analytics",
        kind: "cli",
        config: { provider: "postgres", host: "pg.example.com", port: 5432, user: "app", password: "pw", database: "shop" },
    };
    await drain(cliHandler.apply(ctx, "analytics", postgres.config));
    const skill = await readWorkspaceFile(join(root, ".claude", "skills", "analytics", "SKILL.md"));
    expect(skill).toContain("name: analytics");
    expect(skill).toContain("$POSTGRES_URL_ANALYTICS");
    expect(skill).not.toContain("name: postgres");
});

test("cliEnvOf maps secret + non-secret URL for each provider", () => {
    const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "gh" } };
    const gitlab: Capability = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl", url: "https://gitlab.example.com" } };
    const redmine: Capability = { id: "redmine", kind: "cli", config: { provider: "redmine", url: "https://r.example.com", apiKey: "rk" } };
    const imap: Capability = {
        id: "imap",
        kind: "cli",
        config: { provider: "imap", host: "imap.example.com", port: 993, username: "u@e.com", password: "pw" },
    };
    const postgres: Capability = {
        id: "db",
        kind: "cli",
        config: { provider: "postgres", host: "pg.example.com", port: 5432, user: "app", password: "pw", database: "shop" },
    };
    const mysql: Capability = {
        id: "db",
        kind: "cli",
        config: { provider: "mysql", host: "my.example.com", port: 3306, user: "app", password: "pw", database: "shop" },
    };
    expect(cliEnvOf([github])).toEqual({ GITHUB_TOKEN_GITHUB: "gh" });
    expect(cliEnvOf([gitlab])).toEqual({ GITLAB_TOKEN_GITLAB: "gl", GITLAB_URL_GITLAB: "https://gitlab.example.com" });
    expect(cliEnvOf([redmine])).toEqual({ REDMINE_URL_REDMINE: "https://r.example.com", REDMINE_API_KEY_REDMINE: "rk" });
    expect(cliEnvOf([imap])).toEqual({
        IMAP_HOST_IMAP: "imap.example.com",
        IMAP_PORT_IMAP: "993",
        IMAP_USERNAME_IMAP: "u@e.com",
        IMAP_PASSWORD_IMAP: "pw",
    });
    // postgres is one suffixed connection string the skill passes to psql explicitly (implicit PG* can't be per-instance).
    expect(cliEnvOf([postgres])).toEqual({ POSTGRES_URL_DB: "postgresql://app:pw@pg.example.com:5432/shop" });
    // mysql's plain host/port/user/password/database, suffixed; the skill wires them as flags.
    expect(cliEnvOf([mysql])).toEqual({
        MYSQL_HOST_DB: "my.example.com",
        MYSQL_PORT_DB: "3306",
        MYSQL_USER_DB: "app",
        MYSQL_PASSWORD_DB: "pw",
        MYSQL_DATABASE_DB: "shop",
    });
    // Merges across multiple cli capabilities.
    expect(cliEnvOf([github, redmine])).toEqual({
        GITHUB_TOKEN_GITHUB: "gh",
        REDMINE_URL_REDMINE: "https://r.example.com",
        REDMINE_API_KEY_REDMINE: "rk",
    });
});

test("db providers carry a client-install fragment; the client isn't in the base image", () => {
    const postgres: Capability = {
        id: "db",
        kind: "cli",
        config: { provider: "postgres", host: "pg.example.com", port: 5432, user: "app", password: "pw", database: "shop" },
    };
    const mysql: Capability = {
        id: "db",
        kind: "cli",
        config: { provider: "mysql", host: "my.example.com", port: 3306, user: "app", password: "pw", database: "shop" },
    };
    expect(cliHandler.fragment!(postgres.config)).toContain("postgresql-client");
    expect(cliHandler.fragment!(mysql.config)).toContain("default-mysql-client");
});

test("every provider has a non-empty skill with front-matter", () => {
    for (const [name, provider] of Object.entries(cliProviders)) {
        expect(provider.skill, name).toContain(`name: ${name}`);
        expect(provider.skill.length).toBeGreaterThan(100);
    }
});

test("echoConfig never leaks the token — only provider + hasToken", () => {
    expect(echoConfig(discord)).toEqual({ provider: "discord", hasToken: true });
    const gitlab: Capability = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl", url: "https://gitlab.com" } };
    expect(echoConfig(gitlab)).toEqual({ provider: "gitlab", hasToken: true });
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
// The insteadOf rewrite values git config holds for a host's https base (empty when native ssh is wired). Reads
// the temp HOME's global config; --get-all exits non-zero when the key is absent, which we treat as "none".
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

    // The generated private key is 0600 (ssh refuses looser keys).
    expect(statSync(hostKey(home, "github.com")).mode & 0o777).toBe(0o600);
    const conf = readFileSync(hostConf(home, "github.com"), "utf8");
    expect(conf).toContain("Host github.com");
    expect(conf).toContain("User git");
    expect(conf).toContain("IdentityFile");
    expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toContain("Include intentic-hosts/*.conf");
    // https fallback: a 0600 credential line under the github user, so already-cloned https repos pull/push.
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).toContain("https://x-access-token:gh-tok@github.com");
    expect(statSync(join(home, ".git-credentials")).mode & 0o777).toBe(0o600);
    // The registered key is the freshly generated public half, under the fixed title.
    const publicKey = readFileSync(`${hostKey(home, "github.com")}.pub`, "utf8").trim();
    expect(uploads).toEqual([{ publicKey, title: "intentic-sandbox" }]);
    // Native ssh is wired, so no https rewrite is left behind.
    expect(await httpsRewrite("github.com")).toEqual([]);

    // Re-apply re-attempts registration (idempotent at the provider) but never regenerates the key — the same
    // public half is offered, so no second distinct account key is ever minted.
    expect(await setupGitAccess(host, execInTerminal, deps)).toBeUndefined();
    expect(uploads).toEqual([
        { publicKey, title: "intentic-sandbox" },
        { publicKey, title: "intentic-sandbox" },
    ]);
});

test("git setup reroutes ssh over https + warns (no throw) when ssh-key registration is refused, then a scope-fixed re-add wires native ssh", async () => {
    const home = gitHome();
    const uploads: string[] = [];
    let scoped = false;
    const deps: GitAccessDeps = {
        uploadKey: async (_host, publicKey) => {
            uploads.push(publicKey);
            if (!scoped) {
                throw new Error("GitHub SSH key upload failed (404): Not Found");
            }
        },
        deleteKey: async () => {},
    };
    const host = gitHostOf({ provider: "github", token: "scopeless", git: "on" });

    const warning = await setupGitAccess(host, execInTerminal, deps);

    // Non-fatal: https works, the warning names the scope + shows the pubkey, and the keypair persists for a re-add.
    const publicKey = readFileSync(`${hostKey(home, "github.com")}.pub`, "utf8").trim();
    expect(warning).toContain("write:public_key");
    expect(warning).toContain(publicKey);
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).toContain("https://x-access-token:scopeless@github.com");
    // No forcing ssh-config for an unregistered key; ssh-form remotes are rerouted onto https instead.
    expect(existsSync(hostConf(home, "github.com"))).toBe(false);
    expect(await httpsRewrite("github.com")).toEqual(["git@github.com:", "ssh://git@github.com/"]);

    // Fixing the token scope and re-adding registers the SAME key (no keygen rerun), wires the alias, and drops the
    // https rewrite so native ssh takes over.
    scoped = true;
    expect(await setupGitAccess(host, execInTerminal, deps)).toBeUndefined();
    expect(uploads).toEqual([publicKey, publicKey]);
    expect(existsSync(hostConf(home, "github.com"))).toBe(true);
    expect(await httpsRewrite("github.com")).toEqual([]);
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
    expect(existsSync(hostConf(home, "github.com"))).toBe(false);
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).not.toContain("github.com");
});

test("git teardown also clears the https rewrite left by a refused registration", async () => {
    const home = gitHome();
    const deps: GitAccessDeps = {
        uploadKey: async () => {
            throw new Error("refused");
        },
        deleteKey: async () => {},
    };
    const host = gitHostOf({ provider: "github", token: "scopeless", git: "on" });
    await setupGitAccess(host, execInTerminal, deps);
    expect(await httpsRewrite("github.com")).toEqual(["git@github.com:", "ssh://git@github.com/"]);

    await teardownGitAccess(host, execInTerminal, deps);

    expect(await httpsRewrite("github.com")).toEqual([]);
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
