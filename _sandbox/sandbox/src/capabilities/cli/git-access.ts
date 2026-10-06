import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import type { CliConfig } from "@intentic/sandbox-contract";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { directExec, type ExecInTerminal } from "../../terminal/terminal-run.js";
import { generateSshKey, publicLineOf } from "../credentials/ssh-keys.js";
import type { SshKeyStore } from "../ssh-key-store.js";
import { adoptLegacySshKey, hostConfPath, hostPublicKeyPath, removeSshHost, writeHostPublicKey, writeSshHost } from "../ssh-hosts.js";
import type { ConnectorHook } from "./connector-hooks.js";

// With git access on, the account also names who commits here when the sandbox has no identity (ensureGitIdentity).
// Git access on gets real git credentials beyond the curl-API skill: HTTPS always, set up first, and SSH best-effort.
// SSH: a generated key registered via the token, alias written once confirmed; unregisterable keys route over https.
// The key's private half is made in memory and goes straight into the daemon's key store: the alias names only the
// public half, and the sandbox's ssh agent signs for the owner's own terminal (broker/ssh-agent-keys.ts keeps it from a
// turn, whose git goes through the credential gateway instead).
// Keyed by host; half this state lives on the volume, half on the container's fs, which restoreGitAccess restores.

const KEY_TITLE = "intentic-sandbox";

export interface GitHost {
    readonly provider: "github" | "gitlab";
    // ssh + https host and the ssh-config alias (github.com or gitlab.example.com).
    readonly host: string;
    // REST base for the key up/download (https://api.github.com or https://gitlab.example.com/api/v4).
    readonly apiBase: string;
    readonly token: string;
    // https username the token rides under: github to x-access-token, gitlab to oauth2.
    readonly httpsUser: string;
}

// Maps a github/gitlab capability config to its git host; github is fixed, gitlab derives from the instance url.
export const gitHostOf = (config: CliConfig): GitHost => {
    // Fields are validated present at add-time (the connector's field spec), so read positionally.
    const token = config["token"] ?? "";
    if (config.provider === "github") {
        return { provider: "github", host: "github.com", apiBase: "https://api.github.com", token, httpsUser: "x-access-token" };
    }
    const url = config["url"] ?? "";
    return { provider: "gitlab", host: new URL(url).host, apiBase: `${url.replace(/\/+$/, "")}/api/v4`, token, httpsUser: "oauth2" };
};

// Account calls are the only un-testable seam (network plus a live token), so they're injectable; keygen and git-config
// run for real.
export interface GitAccessDeps {
    readonly uploadKey: (host: GitHost, publicKey: string, title: string) => Promise<void>;
    readonly deleteKey: (host: GitHost, title: string) => Promise<void>;
    // Asked of ssh itself, not the account API, so a token that can't even list keys gets a truthful answer.
    readonly keyAuthenticates: (host: GitHost, keyPath: string) => Promise<boolean>;
    // The account's own name and commit address, for a sandbox with no git identity; absent where nothing asks.
    readonly accountIdentity?: (host: GitHost) => Promise<GitIdentity | undefined>;
}

export interface GitIdentity {
    readonly name: string;
    readonly email: string;
}

const fileExists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );

// HOME is the home directory of record, read per call so a test can point it at a temp dir.
const credentialsPath = (): string => join(process.env["HOME"] ?? homedir(), ".git-credentials");

// Only absence reads as empty: a store that cannot be read is never rewritten as this host's line alone, dropping every
// other host's credential.
const readCredentials = async (): Promise<string> => (await readFile(credentialsPath(), "utf8").catch(undefinedIfMissing)) ?? "";

// Upserts the https credential line for this host (rewrites any prior line, e.g. a rotated token); a plain fs write
// (0600), never a visible command.
const ensureHttpsCredential = async (host: GitHost, exec: ExecInTerminal): Promise<void> => {
    await exec("git", ["config", "--global", "credential.helper", "store"]);
    const line = `https://${host.httpsUser}:${encodeURIComponent(host.token)}@${host.host}`;
    const current = await readCredentials();
    const kept = current.split("\n").filter((entry) => entry.trim() !== "" && !entry.endsWith(`@${host.host}`));
    await writeFile(credentialsPath(), `${[...kept, line].join("\n")}\n`, { mode: 0o600 });
};

const removeHttpsCredential = async (host: GitHost): Promise<void> => {
    const current = await readCredentials();
    if (current === "") {
        return;
    }
    const kept = current.split("\n").filter((entry) => entry.trim() !== "" && !entry.endsWith(`@${host.host}`));
    await writeFile(credentialsPath(), kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
};

// Generates the key pair once (regenerating would orphan an already-registered key); registration isn't done here,
// since it's retried on every apply. Answers the public line, rewriting the alias's public file if it went missing.
const ensureKeyPair = async (host: GitHost, keys: SshKeyStore): Promise<string> => {
    // A key an older build left beside the alias is the one on the account: adopted, never replaced by a new one.
    const held = (await keys.get(host.host)) ?? ((await adoptLegacySshKey(host.host, keys)) ? await keys.get(host.host) : undefined);
    if (held === undefined) {
        const pair = generateSshKey(KEY_TITLE);
        await keys.put(host.host, pair.privateKey);
        await writeHostPublicKey(host.host, pair.publicKey);
        return pair.publicKey;
    }
    const written = (await readFile(hostPublicKeyPath(host.host), "utf8").catch(() => "")).trim();
    if (written !== "") {
        return written;
    }
    const publicLine = publicLineOf(held);
    if (publicLine === undefined) {
        throw new Error(`the key held for ${host.host} could not be read`);
    }
    await writeHostPublicKey(host.host, publicLine);
    return publicLine;
};

const sshRegistrationWarning = (host: GitHost, publicKey: string, err: unknown): string => {
    const scopeHint =
        host.provider === "github"
            ? 'a classic PAT with the write:public_key scope, or a fine-grained token with the "Git SSH keys: write" permission'
            : "a token with the api scope";
    const reason = errorMessage(err);
    return [
        `Git access is on and works over HTTPS (ssh-form remotes are routed there too), but registering a native SSH key failed: ${reason}`,
        `Native ssh://git needs ${scopeHint}. Fix the token and re-add, or add this public key to your ${host.provider} account manually:`,
        publicKey,
    ].join("\n");
};

export const githubHeaders = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });

const uploadKeyReal = async (host: GitHost, publicKey: string, title: string): Promise<void> => {
    if (host.provider === "github") {
        const response = await fetch(`${host.apiBase}/user/keys`, {
            method: "POST",
            headers: { ...githubHeaders(host.token), "Content-Type": "application/json" },
            body: JSON.stringify({ title, key: publicKey }),
        });
        // 422 means the key is already registered; treated as success (idempotent).
        if (!response.ok && response.status !== 422) {
            // allow(silent-catch): The failed HTTP status is still thrown when its optional response body cannot be read.
            throw new Error(`GitHub SSH key upload failed (${response.status}): ${await response.text().catch(() => "")}`);
        }
        return;
    }
    const response = await fetch(`${host.apiBase}/user/keys`, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": host.token, "Content-Type": "application/json" },
        body: JSON.stringify({ title, key: publicKey }),
    });
    // 400 means the fingerprint's already taken; GitLab's idempotent-success equivalent.
    if (!response.ok && response.status !== 400) {
        // allow(silent-catch): The failed HTTP status is still thrown when its optional response body cannot be read.
        throw new Error(`GitLab SSH key upload failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
};

// Best-effort: a stale token or an offline host must not block local teardown, so every failure is swallowed.
// Matches keys by the fixed title; a user who renamed the key on the account keeps it, which is acceptable.
const deleteKeyReal = async (host: GitHost, title: string): Promise<void> => {
    try {
        const listHeaders = host.provider === "github" ? githubHeaders(host.token) : { "PRIVATE-TOKEN": host.token };
        const response = await fetch(`${host.apiBase}/user/keys`, { headers: listHeaders });
        if (!response.ok) {
            return;
        }
        const keys = (await response.json()) as { readonly id: number; readonly title: string }[];
        for (const key of keys.filter((entry) => entry.title === title)) {
            await fetch(`${host.apiBase}/user/keys/${key.id}`, { method: "DELETE", headers: listHeaders });
        }
        // allow(silent-catch): Offline or revoked credentials must not prevent local connection teardown.
    } catch {}
};

// Does the host let this key in? -T runs no command; IdentitiesOnly + -i offer exactly this key; BatchMode avoids
// hanging.
// Read from output, not exit code: both providers refuse a shell with exit 1, indistinguishable from a genuine refusal.
const keyAuthenticatesReal = async (host: GitHost, keyPath: string): Promise<boolean> => {
    const args = [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "IdentitiesOnly=yes",
        "-i",
        keyPath,
        "-T",
        `git@${host.host}`,
    ];
    const output = await directExec("ssh", args).then(
        ({ stdout }) => stdout,
        (error: { readonly stdout?: string; readonly stderr?: string }) => `${error.stdout ?? ""}${error.stderr ?? ""}`,
    );
    return /successfully authenticated|welcome to gitlab/i.test(output);
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

// Who the token belongs to, as a commit should name them: the account's display name (its login when it has none) and
// its own commit address, or the provider's noreply address when the account keeps its email private.
const accountIdentityReal = async (host: GitHost): Promise<GitIdentity | undefined> => {
    const headers = host.provider === "github" ? githubHeaders(host.token) : { "PRIVATE-TOKEN": host.token };
    const response = await fetch(`${host.apiBase}/user`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
        return undefined;
    }
    const user = (await response.json()) as Record<string, unknown>;
    const login = text(user["login"]) ?? text(user["username"]);
    const id = typeof user["id"] === "number" ? user["id"] : undefined;
    if (login === undefined || id === undefined) {
        return undefined;
    }
    const noreply = host.provider === "github" ? `${id}+${login}@users.noreply.github.com` : `${id}-${login}@users.noreply.${host.host}`;
    const email = host.provider === "github" ? text(user["email"]) : (text(user["commit_email"]) ?? text(user["public_email"]));
    return { name: text(user["name"]) ?? login, email: email ?? noreply };
};

const realDeps: GitAccessDeps = {
    uploadKey: uploadKeyReal,
    deleteKey: deleteKeyReal,
    keyAuthenticates: keyAuthenticatesReal,
    accountIdentity: accountIdentityReal,
};

// What the sandbox's own git config says for one key, undefined when it says nothing (`--get` exits 1 then).
const globalGit = async (key: string): Promise<string | undefined> =>
    directExec("git", ["config", "--global", "--get", key]).then(
        ({ stdout }) => text(stdout),
        () => undefined,
    );

// Who commits here when nobody said: the connected account, so an agent's own `git commit` works instead of failing
// "Author identity unknown" and the agent making a name up. Only a key the sandbox leaves unset is written, never one
// the owner set, and a failed lookup leaves both as they are.
export const ensureGitIdentity = async (host: GitHost, exec: ExecInTerminal, deps: GitAccessDeps = realDeps): Promise<void> => {
    const [name, email] = await Promise.all([globalGit("user.name"), globalGit("user.email")]);
    if ((name !== undefined && email !== undefined) || deps.accountIdentity === undefined) {
        return;
    }
    const account = await deps.accountIdentity(host).catch(() => undefined);
    if (account === undefined) {
        return;
    }
    if (name === undefined) {
        await exec("git", ["config", "--global", "user.name", account.name]);
    }
    if (email === undefined) {
        await exec("git", ["config", "--global", "user.email", account.email]);
    }
};

// https base every ssh-form remote for this host rewrites onto, keyed so github.com and a self-hosted gitlab don't
// collide; trailing slash makes both remote forms land on the same URL.
const rewriteKey = (host: GitHost): string => `url.https://${host.host}/.insteadOf`;

// Asks git itself rather than reading ~/.gitconfig, since the value can arrive through an include; an absent key exits
// 1, so "no rewrite" is a rejection, not empty output.
const httpsRewriteEnabled = async (host: GitHost): Promise<boolean> =>
    directExec("git", ["config", "--global", "--get-all", rewriteKey(host)]).then(
        ({ stdout }) => stdout.trim() !== "",
        () => false,
    );

// Routes ssh-form remotes over https, the fallback when a key can't be registered; --replace-all seeds one value, --add
// appends the second, so a re-apply stays at two entries.
const enableHttpsRewrite = async (host: GitHost, exec: ExecInTerminal): Promise<void> => {
    await exec("git", ["config", "--global", "--replace-all", rewriteKey(host), `git@${host.host}:`]);
    await exec("git", ["config", "--global", "--add", rewriteKey(host), `ssh://git@${host.host}/`]);
};

// Drops the rewrite (native ssh registered, or teardown); probes first, since --unset-all exits 5 when absent.
// The probe is invisible; only a removal that has something to remove shows up as a command.
const disableHttpsRewrite = async (host: GitHost, exec: ExecInTerminal): Promise<void> => {
    if (!(await httpsRewriteEnabled(host))) {
        return;
    }
    await exec("git", ["config", "--global", "--unset-all", rewriteKey(host)]);
};

// Returns undefined when native ssh is wired, or a warning when the key can't be registered and remotes route over
// https.
// HTTPS configures first and unconditionally so git works either way; the alias writes only once the key is confirmed.
export const setupGitAccess = async (
    host: GitHost,
    exec: ExecInTerminal,
    keys: SshKeyStore,
    deps: GitAccessDeps = realDeps,
): Promise<string | undefined> => {
    await ensureHttpsCredential(host, exec);
    await ensureGitIdentity(host, exec, deps);
    const publicKey = await ensureKeyPair(host, keys);
    const refusal = await deps.uploadKey(host, publicKey, KEY_TITLE).then(
        () => undefined,
        (err: unknown) => err,
    );
    // A refused upload doesn't settle it: asks ssh directly, since a hand-added key may work despite the refusal.
    // The daemon's own ssh reads the store's file directly: it is root, and this probe is no turn's.
    if (refusal !== undefined && !(await deps.keyAuthenticates(host, keys.pathOf(host.host)))) {
        // Genuinely absent: drops any stale alias (keeps the keypair for later), routes remotes over https instead.
        await rm(hostConfPath(host.host), { force: true });
        await enableHttpsRewrite(host, exec);
        return sshRegistrationWarning(host, publicKey, refusal);
    }
    // On the account: wires the ssh alias and drops any https rewrite left by an earlier failed apply.
    await writeSshHost(host.host, { host: host.host, user: "git", port: 22, identityFile: hostPublicKeyPath(host.host) });
    await disableHttpsRewrite(host, exec);
    return undefined;
};

// Boot half of setupGitAccess: re-derives what HOME lost (credential helper, https line, alias or rewrite).
// No account call: a persisted keypair is already registered; a missing keypair is the one case needing the full apply.
export const restoreGitAccess = async (
    host: GitHost,
    exec: ExecInTerminal,
    keys: SshKeyStore,
    deps: GitAccessDeps = realDeps,
): Promise<string | undefined> => {
    if (!(await keys.has(host.host))) {
        return setupGitAccess(host, exec, keys, deps);
    }
    await ensureHttpsCredential(host, exec);
    // A recreated container lost its global git config, the identity with it.
    await ensureGitIdentity(host, exec, deps);
    // Alias next to the key means the key is on the account: written only after a successful upload.
    if (await fileExists(hostConfPath(host.host))) {
        await ensureKeyPair(host, keys);
        await writeSshHost(host.host, { host: host.host, user: "git", port: 22, identityFile: hostPublicKeyPath(host.host) });
        return undefined;
    }
    await enableHttpsRewrite(host, exec);
    return undefined;
};

// Whether both halves of access are in place: the https line alone doesn't work ssh remotes without the key or rewrite.
// Neither route present looks active but fails Permission denied, what repointing ~/.ssh/intentic-hosts leaves behind.
export const gitAccessWired = async (host: GitHost, keys: SshKeyStore): Promise<boolean> => {
    const current = await readFile(credentialsPath(), "utf8").catch(() => "");
    if (!current.split("\n").some((entry) => entry.endsWith(`@${host.host}`))) {
        return false;
    }
    // Alias written only after a successful registration; its presence claims ssh only while the key still exists.
    if (await fileExists(hostConfPath(host.host))) {
        return keys.has(host.host);
    }
    return httpsRewriteEnabled(host);
};

export const teardownGitAccess = async (
    host: GitHost,
    exec: ExecInTerminal,
    keys: SshKeyStore,
    deps: GitAccessDeps = realDeps,
): Promise<void> => {
    // Never set up (or already off): no local files, no account key, no-op without touching the network. A key an older
    // build left beside the alias counts as set up.
    await adoptLegacySshKey(host.host, keys);
    if (!(await keys.has(host.host))) {
        return;
    }
    // Best-effort account cleanup first (needs network and a valid token); local files always go regardless.
    await deps.deleteKey(host, KEY_TITLE);
    await removeSshHost(host.host);
    await keys.remove(host.host);
    await disableHttpsRewrite(host, exec);
    await removeHttpsCredential(host);
};

export const gitAccessHook: ConnectorHook = {
    // "on" sets up ssh+https; an explicit off (or a switched-off connection) tears down, so re-apply is idempotent both
    // ways.
    apply: async (config, exec, keys) => {
        const host = gitHostOf(config);
        if (config["git"] === "on") {
            return setupGitAccess(host, exec, keys);
        }
        await teardownGitAccess(host, exec, keys);
        return undefined;
    },
    remove: (config, exec, keys) => teardownGitAccess(gitHostOf(config), exec, keys),
    // Nothing to restore with git access off: the connector is then just env + skill, both already on /work.
    restore: async (config, exec, keys) => (config["git"] === "on" ? restoreGitAccess(gitHostOf(config), exec, keys) : undefined),
};
