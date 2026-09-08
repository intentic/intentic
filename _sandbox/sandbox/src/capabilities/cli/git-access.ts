import { errorMessage } from "@intentic/base/errors";
import type { CliConfig } from "@intentic/sandbox-contract";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { directExec, type ExecInTerminal } from "../../terminal/terminal-run.js";
import { hostConfPath, hostKeyPath, hostsDir, removeSshHost, writeSshHost } from "../ssh-hosts.js";
import type { ConnectorHook } from "./connector-hooks.js";

// Git access on gets real git credentials beyond the curl-API skill: HTTPS always, set up first, and SSH best-effort.
// SSH: a generated key registered via the token, alias written once confirmed; unregisterable keys route over https.
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
}

const fileExists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );

const credentialsPath = (): string => join(homedir(), ".git-credentials");

// Upserts the https credential line for this host (rewrites any prior line, e.g. a rotated token); a plain fs write
// (0600), never a visible command.
const ensureHttpsCredential = async (host: GitHost, exec: ExecInTerminal): Promise<void> => {
    await exec("git", ["config", "--global", "credential.helper", "store"]);
    const line = `https://${host.httpsUser}:${encodeURIComponent(host.token)}@${host.host}`;
    const current = await readFile(credentialsPath(), "utf8").catch(() => "");
    const kept = current.split("\n").filter((entry) => entry.trim() !== "" && !entry.endsWith(`@${host.host}`));
    await writeFile(credentialsPath(), `${[...kept, line].join("\n")}\n`, { mode: 0o600 });
};

const removeHttpsCredential = async (host: GitHost): Promise<void> => {
    const current = await readFile(credentialsPath(), "utf8").catch(() => "");
    if (current === "") {
        return;
    }
    const kept = current.split("\n").filter((entry) => entry.trim() !== "" && !entry.endsWith(`@${host.host}`));
    await writeFile(credentialsPath(), kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
};

// Generates the key pair once (regenerating would orphan an already-registered key); registration isn't done here,
// since it's retried on every apply.
const ensureKeyPair = async (host: GitHost, exec: ExecInTerminal): Promise<string> => {
    const keyPath = hostKeyPath(host.host);
    if (!(await fileExists(keyPath))) {
        await mkdir(hostsDir(), { recursive: true, mode: 0o700 });
        await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", KEY_TITLE, "-f", keyPath]);
    }
    return (await readFile(`${keyPath}.pub`, "utf8")).trim();
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
    } catch {
    }
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

const realDeps: GitAccessDeps = { uploadKey: uploadKeyReal, deleteKey: deleteKeyReal, keyAuthenticates: keyAuthenticatesReal };

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
export const setupGitAccess = async (host: GitHost, exec: ExecInTerminal, deps: GitAccessDeps = realDeps): Promise<string | undefined> => {
    await ensureHttpsCredential(host, exec);
    const publicKey = await ensureKeyPair(host, exec);
    const refusal = await deps.uploadKey(host, publicKey, KEY_TITLE).then(
        () => undefined,
        (err: unknown) => err,
    );
    // A refused upload doesn't settle it: asks ssh directly, since a hand-added key may work despite the refusal.
    if (refusal !== undefined && !(await deps.keyAuthenticates(host, hostKeyPath(host.host)))) {
        // Genuinely absent: drops any stale alias (keeps the keypair for later), routes remotes over https instead.
        await rm(hostConfPath(host.host), { force: true });
        await enableHttpsRewrite(host, exec);
        return sshRegistrationWarning(host, publicKey, refusal);
    }
    // On the account: wires the ssh alias and drops any https rewrite left by an earlier failed apply.
    await writeSshHost(host.host, { host: host.host, user: "git", port: 22, identityFile: hostKeyPath(host.host) });
    await disableHttpsRewrite(host, exec);
    return undefined;
};

// Boot half of setupGitAccess: re-derives what HOME lost (credential helper, https line, alias or rewrite).
// No account call: a persisted keypair is already registered; a missing keypair is the one case needing the full apply.
export const restoreGitAccess = async (host: GitHost, exec: ExecInTerminal, deps: GitAccessDeps = realDeps): Promise<string | undefined> => {
    if (!(await fileExists(hostKeyPath(host.host)))) {
        return setupGitAccess(host, exec, deps);
    }
    await ensureHttpsCredential(host, exec);
    // Alias next to the key means the key is on the account: written only after a successful upload.
    if (await fileExists(hostConfPath(host.host))) {
        await writeSshHost(host.host, { host: host.host, user: "git", port: 22, identityFile: hostKeyPath(host.host) });
        return undefined;
    }
    await enableHttpsRewrite(host, exec);
    return undefined;
};

// Whether both halves of access are in place: the https line alone doesn't work ssh remotes without the key or rewrite.
// Neither route present looks active but fails Permission denied, what repointing ~/.ssh/intentic-hosts leaves behind.
export const gitAccessWired = async (host: GitHost): Promise<boolean> => {
    const current = await readFile(credentialsPath(), "utf8").catch(() => "");
    if (!current.split("\n").some((entry) => entry.endsWith(`@${host.host}`))) {
        return false;
    }
    // Alias written only after a successful registration; its presence claims ssh only while the key still exists.
    if (await fileExists(hostConfPath(host.host))) {
        return fileExists(hostKeyPath(host.host));
    }
    return httpsRewriteEnabled(host);
};

export const teardownGitAccess = async (host: GitHost, exec: ExecInTerminal, deps: GitAccessDeps = realDeps): Promise<void> => {
    // Never set up (or already off): no local files, no account key, no-op without touching the network.
    if (!(await fileExists(hostKeyPath(host.host)))) {
        return;
    }
    // Best-effort account cleanup first (needs network and a valid token); local files always go regardless.
    await deps.deleteKey(host, KEY_TITLE);
    await removeSshHost(host.host);
    await rm(`${hostKeyPath(host.host)}.pub`, { force: true });
    await disableHttpsRewrite(host, exec);
    await removeHttpsCredential(host);
};

export const gitAccessHook: ConnectorHook = {
    // "on" sets up ssh+https; an explicit off (or a switched-off connection) tears down, so re-apply is idempotent both
    // ways.
    apply: async (config, exec) => {
        const host = gitHostOf(config);
        if (config["git"] === "on") {
            return setupGitAccess(host, exec);
        }
        await teardownGitAccess(host, exec);
        return undefined;
    },
    remove: (config, exec) => teardownGitAccess(gitHostOf(config), exec),
    // Nothing to restore with git access off: the connector is then just env + skill, both already on /work.
    restore: async (config, exec) => (config["git"] === "on" ? restoreGitAccess(gitHostOf(config), exec) : undefined),
};
