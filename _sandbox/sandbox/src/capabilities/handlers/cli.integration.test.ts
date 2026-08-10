import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { CapabilityContributionSchema } from "@intentic/extension-manifest";
import { exec } from "@intentic/scaffold";
import type { Capability, CliConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { setListenerStatus } from "../../extensions/listener-status.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import { createTerminalRunner, directExec } from "../../terminal/terminal-run.js";
import { makeWorkspaceDir, readWorkspaceFile, removeWorkspacePath, writeWorkspaceFile } from "../../workspace/workspace-files.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import type { CapabilityCtx } from "../capability.js";
import { echoConfig } from "../summary.js";
import { cliEnvOf } from "../cli-env.js";
import { contributedSkill, contributionRegistry } from "../contributions.js";
import { restoreConnectorHooks } from "../cli/connector-hooks.js";
import { type GitAccessDeps, gitAccessWired, gitHostOf, restoreGitAccess, setupGitAccess, teardownGitAccess } from "../cli/git-access.js";
import { stripNpmAuth, upsertNpmAuth } from "../cli/npm-access.js";
import { linkSshHosts } from "../ssh-hosts.js";
import { cliHandler } from "./cli.js";

// The real first-party connectors/discord extensions provide every provider's data (fields/env/skill/fragment).
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// A ctx exposing only what cliHandler touches (files + workspace.root + capabilities + extensionsDir + the
// terminal runner in its no-tmux fallback), over a fresh temp workspace. HOME is a temp dir so the github/gitlab
// git-access hook never touches the real home.
const tempCtx = (capabilities: Capability[] = []): { ctx: CapabilityCtx; root: string } => {
    const root = mkdtempSync(join(tmpdir(), "cli-cap-"));
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "cli-cap-home-"));
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
        workspace: { root: WORKSPACE_ROOT },
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

test("apply writes the connector's SKILL.md; discord voice pends only when the gateway reports whisper missing", async () => {
    const { ctx, root } = tempCtx();
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "inactive" });

    await drain(cliHandler.apply(ctx, "discord", discord.config));

    const skill = await readWorkspaceFile(skillPath(root, "discord"));
    expect(skill).toContain("name: discord");
    expect(skill).toContain("$DISCORD_BOT_TOKEN");
    expect(skill).toContain("https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=1117248");
    expect(skill).toContain("discord-voice");
    expect(skill).not.toContain("FROM ghcr.io");
    // No gateway status yet ⇒ text tools active; whisper state is unknown, so it doesn't pend.
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "active" });
    // Once the gateway reports whisper missing (its /listeners/discord/status post), voice pends on a rebuild.
    setListenerStatus("discord", { connections: [], whisperReady: false }, Date.now());
    expect(await cliHandler.status(ctx, "discord", discord.config)).toEqual({ state: "pending", detail: "voice needs a rebuild (whisper)" });
});

test("whatsapp pends with the pairing code while the gateway is waiting for the phone, and clears when it stops", async () => {
    const whatsapp: Capability = { id: "whatsapp", kind: "cli", config: { provider: "whatsapp", phoneNumber: "+49 151 12345678" } };
    const { ctx } = tempCtx();
    await drain(cliHandler.apply(ctx, "whatsapp", whatsapp.config));
    // The gateway publishes each waiting capability's code via /listeners/whatsapp/status; the card shows it.
    setListenerStatus("whatsapp", { connections: [], pairing: { whatsapp: "ABCD-EFGH" } }, Date.now());
    expect(await cliHandler.status(ctx, "whatsapp", whatsapp.config)).toEqual({
        state: "pending",
        detail: "enter ABCD-EFGH on the phone: WhatsApp → Linked devices → Link with phone number",
    });
    // Paired: the gateway stops publishing the code and the card goes active. The code is keyed by capability
    // id, so ANOTHER whatsapp capability's pairing must not pend this one.
    setListenerStatus("whatsapp", { connections: [], pairing: { other: "ZZZZ-YYYY" } }, Date.now());
    expect(await cliHandler.status(ctx, "whatsapp", whatsapp.config)).toEqual({ state: "active" });
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
        config: { provider: "imap", host: "imap.example.com", port: "993", username: "u@e.com", password: "p#ss@word: &$100%!" },
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
    // The password passes through byte-exact — no encoding on the env path (curl --user sends it verbatim);
    // only ${field:uri} templates (postgres below) percent-encode.
    expect(await cliEnvOf(hostFor([imap]))).toEqual({
        IMAP_HOST_IMAP: "imap.example.com",
        IMAP_PORT_IMAP: "993",
        IMAP_USERNAME_IMAP: "u@e.com",
        IMAP_PASSWORD_IMAP: "p#ss@word: &$100%!",
    });
    // The postgres URL template percent-encodes user/password/database (${field:uri}).
    expect(await cliEnvOf(hostFor([primary, secondary]))).toEqual({
        POSTGRES_URL_ANALYTICS: "postgresql://app:pw1@a.example.com:5432/metrics",
        POSTGRES_URL_BILLING: "postgresql://app:pw2@b.example.com:5432/invoices",
    });
});

test("echoConfig never leaks the secret — the token becomes hasSecret", async () => {
    const connectors = await contributionRegistry(hostFor([]));
    expect(echoConfig(discord, connectors)).toEqual({ provider: "discord", hasSecret: true });
    const gitlab: Capability = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl", url: "https://gitlab.com" } };
    // Non-secret fields (provider, url) echo; the secret token becomes hasSecret and never its value.
    expect(echoConfig(gitlab, connectors)).toEqual({ provider: "gitlab", url: "https://gitlab.com", hasSecret: true });
});

/* WHICH FIELDS ARE SECRET IS THE CONNECTOR'S DATA, so an unresolvable connector means the daemon does not
 * know — and "don't know" has to withhold. An extension switched off, uninstalled, or whose manifest stopped
 * parsing all resolve the same way, and the empty secret-key set that used to fall out of that echoed every
 * stored credential onto the /capabilities list, which maintainers can read. The leak depended on unrelated
 * extension state rather than on anything about the credential, which is what made it easy to miss. */
test("echoConfig withholds everything but the discriminator when the connector cannot be resolved", async () => {
    const noConnectors = new Map();
    const gitlab: Capability = { id: "gitlab", kind: "cli", config: { provider: "gitlab", token: "gl-secret-value", url: "https://gitlab.com" } };
    const echoed = echoConfig(gitlab, noConnectors);
    expect(echoed).toEqual({ provider: "gitlab", hasSecret: false });
    expect(JSON.stringify(echoed)).not.toContain("gl-secret-value");
});

// ---- git access (github/gitlab clone/pull/push in the terminal) ----
// The account-key REST calls are the injectable seam; keygen + git-config run for real against a temp HOME.
// Through directExec, NOT the terminal runner: where tmux-run exists (running this suite inside a sandbox) the
// runner hands the command to the container's tmux server, whose env — and therefore whose HOME — is the real
// /root, so every `git config --global` here would land in the sandbox's own config instead of the temp home.

const gitHome = (): string => {
    const home = mkdtempSync(join(tmpdir(), "git-cap-home-"));
    process.env["HOME"] = home;
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
    const deps: GitAccessDeps = {
        uploadKey: async (_host, publicKey, title) => void uploads.push({ publicKey, title }),
        deleteKey: async () => {},
        keyAuthenticates: async () => false,
    };
    const host = gitHostOf({ provider: "github", token: "gh-tok", git: "on" });

    expect(await setupGitAccess(host, directExec, deps)).toBeUndefined();

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
        keyAuthenticates: async () => false,
    };
    const host = gitHostOf({ provider: "github", token: "scopeless", git: "on" });

    const warning = await setupGitAccess(host, directExec, deps);

    const publicKey = readFileSync(`${hostKey(home, "github.com")}.pub`, "utf8").trim();
    expect(warning).toContain("write:public_key");
    expect(warning).toContain(publicKey);
    expect(existsSync(hostConf(home, "github.com"))).toBe(false);
    expect(await httpsRewrite("github.com")).toEqual(["git@github.com:", "ssh://git@github.com/"]);
});

test("git setup wires native ssh anyway when the refused key is already on the account (added by hand)", async () => {
    const home = gitHome();
    const probed: string[] = [];
    // The token can't manage keys — the state a `repo`-only PAT leaves — but the owner followed the warning and
    // pasted the public half into their account, so ssh lets the key in.
    const deps: GitAccessDeps = {
        uploadKey: async () => {
            throw new Error("GitHub SSH key upload failed (404): Not Found");
        },
        deleteKey: async () => {},
        keyAuthenticates: async (_host, keyPath) => probed.push(keyPath) > 0,
    };
    const host = gitHostOf({ provider: "github", token: "scopeless", git: "on" });

    expect(await setupGitAccess(host, directExec, deps)).toBeUndefined();

    expect(probed).toEqual([hostKey(home, "github.com")]);
    // The alias is what every later boot reads, so writing it here is what makes the hand-added key survive a
    // rebuild instead of silently dropping back to https.
    expect(readFileSync(hostConf(home, "github.com"), "utf8")).toContain("Host github.com");
    expect(await httpsRewrite("github.com")).toEqual([]);
});

test("git setup (gitlab): host + https user derive from the instance url", async () => {
    const home = gitHome();
    const deps: GitAccessDeps = { uploadKey: async () => {}, deleteKey: async () => {}, keyAuthenticates: async () => false };
    const host = gitHostOf({ provider: "gitlab", token: "gl-tok", url: "https://gitlab.example.com", git: "on" });

    await setupGitAccess(host, directExec, deps);

    expect(existsSync(hostConf(home, "gitlab.example.com"))).toBe(true);
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).toContain("https://oauth2:gl-tok@gitlab.example.com");
});

test("git teardown: deletes the account key and removes the local key, ssh alias and https line", async () => {
    const home = gitHome();
    let deleted = 0;
    const deps: GitAccessDeps = { uploadKey: async () => {}, deleteKey: async () => void (deleted += 1), keyAuthenticates: async () => false };
    const host = gitHostOf({ provider: "github", token: "gh-tok", git: "on" });
    await setupGitAccess(host, directExec, deps);

    await teardownGitAccess(host, directExec, deps);

    expect(deleted).toBe(1);
    expect(existsSync(hostKey(home, "github.com"))).toBe(false);
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).not.toContain("github.com");
});

test("git teardown is a no-op (no account call) when nothing was ever set up", async () => {
    gitHome();
    let deleted = 0;
    const deps: GitAccessDeps = { uploadKey: async () => {}, deleteKey: async () => void (deleted += 1), keyAuthenticates: async () => false };
    await teardownGitAccess(gitHostOf({ provider: "github", token: "x", git: "off" }), directExec, deps);
    expect(deleted).toBe(0);
});

// ---- the boot restore (a container recreate: new HOME, same /history volume) ----

const gitlabOn: CliConfig = { provider: "gitlab", url: "https://gitlab.com", token: "gl-tok", git: "on" };

test("status: a git-access connector pends while the container holds no git credentials", async () => {
    const { ctx, root } = tempCtx();
    await writeWorkspaceFile(skillPath(root, "gitlab"), "---\nname: gitlab\n---\n");

    // The skill (on /work) survived the recreate; the credentials (in HOME) did not.
    expect(await cliHandler.status(ctx, "gitlab", gitlabOn)).toEqual({ state: "pending", detail: "git access needs a re-add" });

    await setupGitAccess(gitHostOf(gitlabOn), directExec, {
        uploadKey: async () => {},
        deleteKey: async () => {},
        keyAuthenticates: async () => false,
    });

    expect(await cliHandler.status(ctx, "gitlab", gitlabOn)).toEqual({ state: "active" });
});

test("git restore: a recreated container gets its credentials back without registering another account key", async () => {
    const history = mkdtempSync(join(tmpdir(), "git-cap-history-"));
    gitHome();
    await linkSshHosts(history);
    const uploads: string[] = [];
    const deps: GitAccessDeps = {
        uploadKey: async (_host, publicKey) => void uploads.push(publicKey),
        deleteKey: async () => {},
        keyAuthenticates: async () => false,
    };
    const host = gitHostOf(gitlabOn);
    await setupGitAccess(host, directExec, deps);
    expect(uploads).toHaveLength(1);

    // The recreate: a brand-new container filesystem, the volume intact.
    const home = gitHome();
    await linkSshHosts(history);
    expect(await gitAccessWired(host)).toBe(false);

    expect(await restoreGitAccess(host, directExec, deps)).toBeUndefined();

    // The persisted keypair is already on the account — re-uploading it is exactly what piled up dead keys.
    expect(uploads).toHaveLength(1);
    expect(readFileSync(join(home, ".git-credentials"), "utf8")).toContain("https://oauth2:gl-tok@gitlab.com");
    expect(readFileSync(join(home, ".ssh", "config"), "utf8")).toContain("Include intentic-hosts/*.conf");
    expect(readFileSync(hostConf(home, "gitlab.com"), "utf8")).toContain("Host gitlab.com");
    // Native ssh is wired, so ssh-form remotes are NOT rerouted over https.
    expect(await httpsRewrite("gitlab.com")).toEqual([]);
    expect(await gitAccessWired(host)).toBe(true);
});

test("git restore falls back to the full setup when no keypair was persisted", async () => {
    const home = gitHome();
    const uploads: string[] = [];
    const deps: GitAccessDeps = {
        uploadKey: async (_host, publicKey) => void uploads.push(publicKey),
        deleteKey: async () => {},
        keyAuthenticates: async () => false,
    };

    await restoreGitAccess(gitHostOf(gitlabOn), directExec, deps);

    expect(uploads).toEqual([readFileSync(`${hostKey(home, "gitlab.com")}.pub`, "utf8").trim()]);
    expect(existsSync(hostConf(home, "gitlab.com"))).toBe(true);
});

test("git restore keeps ssh-form remotes on https when the key had never been registered", async () => {
    const history = mkdtempSync(join(tmpdir(), "git-cap-history-"));
    gitHome();
    await linkSshHosts(history);
    let uploads = 0;
    const refused: GitAccessDeps = {
        uploadKey: async () => {
            uploads += 1;
            throw new Error("GitLab SSH key upload failed (403): insufficient_scope");
        },
        deleteKey: async () => {},
        keyAuthenticates: async () => false,
    };
    const host = gitHostOf(gitlabOn);
    expect(await setupGitAccess(host, directExec, refused)).toContain("api scope");

    gitHome();
    await linkSshHosts(history);
    await restoreGitAccess(host, directExec, refused);

    // No alias next to the persisted key ⇒ registration had been refused ⇒ the https rewrite comes back, and
    // the restore doesn't retry the upload (a re-add is what retries it).
    expect(uploads).toBe(1);
    expect(await httpsRewrite("gitlab.com")).toEqual(["git@gitlab.com:", "ssh://git@gitlab.com/"]);
    expect(await gitAccessWired(host)).toBe(true);
});

test("git access whose ssh alias was taken out from under it pends instead of reading active", async () => {
    const { ctx, root } = tempCtx();
    await writeWorkspaceFile(skillPath(root, "gitlab"), "---\nname: gitlab\n---\n");
    await linkSshHosts(mkdtempSync(join(tmpdir(), "git-cap-history-")));
    const host = gitHostOf(gitlabOn);
    await setupGitAccess(host, directExec, { uploadKey: async () => {}, deleteKey: async () => {}, keyAuthenticates: async () => false });
    expect(await cliHandler.status(ctx, "gitlab", gitlabOn)).toEqual({ state: "active" });

    // What a second daemon repointing the managed dir at ITS history root leaves behind: the https credential
    // is untouched in HOME, the alias and key it was written beside are unreachable, and nothing routes
    // `git@gitlab.com:` anywhere — the card has to say so rather than keep claiming git access works.
    await linkSshHosts(mkdtempSync(join(tmpdir(), "git-cap-history-")));

    expect(await gitAccessWired(host)).toBe(false);
    expect(await cliHandler.status(ctx, "gitlab", gitlabOn)).toEqual({ state: "pending", detail: "git access needs a re-add" });
});

test("restoreConnectorHooks walks the manifest: hooked connectors only, one failure never stops the rest", async () => {
    const history = mkdtempSync(join(tmpdir(), "git-cap-history-"));
    gitHome();
    await linkSshHosts(history);
    // Wire gitlab first, then recreate — so the boot pass takes the offline branch it takes in production
    // (this is the only call path that uses the real account deps; a persisted key must never reach for one).
    await setupGitAccess(gitHostOf(gitlabOn), directExec, {
        uploadKey: async () => {},
        deleteKey: async () => {},
        keyAuthenticates: async () => false,
    });
    const home = gitHome();
    await linkSshHosts(history);
    const warnings: string[] = [];
    const capabilities = {
        list: async (): Promise<Capability[]> => [
            discord,
            { id: "github", kind: "cli", config: { provider: "github", token: "gh", git: "off" } },
            { id: "broken", kind: "cli", config: { provider: "gitlab", url: "not-a-url", token: "x", git: "on" } },
            { id: "gitlab", kind: "cli", config: gitlabOn },
        ],
    } as unknown as CapabilitiesStore;

    await restoreConnectorHooks(capabilities, { warn: (message) => void warnings.push(message) });

    const credentials = readFileSync(join(home, ".git-credentials"), "utf8");
    expect(credentials).toContain("@gitlab.com");
    // discord has no git hook, and github's git access is off — neither writes a credential.
    expect(credentials).not.toContain("@github.com");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("connector broken:");
});

// ---- npm (the ~/.npmrc auth line the npm CLI reads) ----

const npm: Capability = {
    id: "npm",
    kind: "cli",
    config: { provider: "npm", token: "npm-tok-1", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" },
};

test("npm auth rewrite is an upsert that keeps the rest of ~/.npmrc", () => {
    expect(upsertNpmAuth("", "t1")).toBe("//registry.npmjs.org/:_authToken=t1\n");
    const mixed = "save-exact=true\n//registry.npmjs.org/:_authToken=old\nregistry=https://registry.npmjs.org/\n";
    expect(upsertNpmAuth(mixed, "rotated")).toBe("save-exact=true\nregistry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=rotated\n");
    expect(stripNpmAuth(upsertNpmAuth(mixed, "rotated"))).toBe("save-exact=true\nregistry=https://registry.npmjs.org/\n");
    expect(stripNpmAuth("//registry.npmjs.org/:_authToken=only\n")).toBe("");
});

test("npm: apply writes the auth line + templated skill; a wiped HOME pends until the boot restore rewrites it", async () => {
    const { ctx, root } = tempCtx();
    const home = process.env["HOME"] ?? "";

    await drain(cliHandler.apply(ctx, "npm", npm.config));

    const skill = await readWorkspaceFile(skillPath(root, "npm"));
    expect(skill).toContain("name: npm");
    // The skill's otp examples are minted for THIS instance, and its env var carries the instance suffix.
    expect(skill).toContain("$(otp npm)");
    expect(skill).toContain("$NPM_TOKEN_NPM");
    expect(readFileSync(join(home, ".npmrc"), "utf8")).toBe("//registry.npmjs.org/:_authToken=npm-tok-1\n");
    expect(statSync(join(home, ".npmrc")).mode & 0o777).toBe(0o600);
    expect(await cliHandler.status(ctx, "npm", npm.config)).toEqual({ state: "active" });

    // A container recreate wipes HOME while the connection survives — the card must say so, and the boot
    // restore must heal it without a re-add.
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "npm-cap-home-"));
    expect(await cliHandler.status(ctx, "npm", npm.config)).toEqual({ state: "pending", detail: "npm auth needs a re-add" });
    await restoreConnectorHooks({ list: async () => [npm] } as unknown as CapabilitiesStore, { warn: () => {} });
    expect(await cliHandler.status(ctx, "npm", npm.config)).toEqual({ state: "active" });

    await cliHandler.remove!(ctx, "npm", npm.config);
    expect(readFileSync(join(process.env["HOME"] ?? "", ".npmrc"), "utf8")).toBe("");
    expect(await cliHandler.status(ctx, "npm", npm.config)).toEqual({ state: "inactive" });
});

test("a cli contribution whose env references a totp field fails to parse", () => {
    const spec = {
        id: "x",
        kind: "cli",
        catalog: { name: "X", description: "d", category: "code" },
        fields: [
            { key: "token", label: "Token", secret: true },
            { key: "totpSecret", label: "Seed", secret: true, totp: true, optional: true },
        ],
        env: { X_TOKEN: "${token}" },
        skill: "skills/x/SKILL.md",
    };
    expect(CapabilityContributionSchema.safeParse(spec).success).toBe(true);
    // The one thing a totp field must never do — ride the env into the agent's shell.
    const leaking = CapabilityContributionSchema.safeParse({ ...spec, env: { ...spec.env, X_SEED: "${totpSecret}" } });
    expect(leaking.success ? [] : leaking.error.issues.map((issue) => issue.message)).toEqual([
        'env must not reference the totp field "totpSecret" — the daemon mints codes from it instead',
    ]);
});

/* A SKILL TEMPLATE MAY QUOTE THE FORM, BUT NEVER A SECRET. The `${field}` pass exists so one pack can serve a
 * card that knows nothing about its site (the generic browser session names the page and purpose the user typed).
 * A skill file is plain text in the workspace that the agent reads every turn — so a pack referencing a secret
 * field must render EMPTY rather than copy a token out of the one place that guards it. Same rule as the totp
 * check above, at the other seam where a card's values leave the manifest. */
test("a skill template's ${field} pass substitutes answers but never a secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-sub-"));
    mkdirSync(join(dir, "skills", "x"), { recursive: true });
    writeFileSync(
        join(dir, "skills", "x", "SKILL.md"),
        "---\nname: x\ndescription: for ${label}\n---\ntoken=[${token}] label=[${label}] id=[${id}]\n",
    );
    const contribution = {
        spec: {
            id: "x",
            kind: "cli",
            catalog: { name: "X", description: "d", category: "code" },
            fields: [
                { key: "token", label: "Token", secret: true },
                { key: "label", label: "Label" },
            ],
            env: {},
            skill: "skills/x/SKILL.md",
        },
        extension: { dir },
    } as unknown as Parameters<typeof contributedSkill>[0];

    const skill = await contributedSkill(contribution, "mine", "", { token: "super-secret", label: "our staging box" });

    expect(skill).toContain("label=[our staging box]");
    expect(skill).toContain("id=[mine]");
    expect(skill).toContain("token=[]");
    expect(skill).not.toContain("super-secret");
    // The frontmatter is substituted too — that line is what the agent routes on.
    expect(skill).toContain("description: for our staging box");
    expect(skill).toContain("name: mine");
});

test("npm: the totp seed reaches neither the echo nor the agent env", async () => {
    const connectors = await contributionRegistry(hostFor([]));
    // Both secrets are withheld; hasSecret speaks for the rotatable token, never the seed's value.
    expect(echoConfig(npm, connectors)).toEqual({ provider: "npm", hasSecret: true });
    // The env template exports the token alone — the manifest schema would reject one referencing totpSecret.
    expect(await cliEnvOf(hostFor([npm]))).toEqual({ NPM_TOKEN_NPM: "npm-tok-1" });
});
