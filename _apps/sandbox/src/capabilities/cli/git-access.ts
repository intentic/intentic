import type { CliConfig } from "@intentic/sandbox-contract";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecInTerminal } from "../../system/terminal-run.js";
import { hostConfPath, hostKeyPath, hostsDir, removeSshHost, writeSshHost } from "../ssh-hosts.js";

// A connected git provider (github/gitlab) with git access on gets more than the curl-API skill: real git creds so
// the owner can `git pull`/`git push` in the interactive terminal (Ctrl+`) and the agent can clone/push too. Two
// INDEPENDENT transports, both landing under the shared root HOME (terminal + agent + daemon):
//   - HTTPS (always): a `~/.git-credentials` line so repos cloned over https (what the app clones) pull/push with
//     no extra scope — this alone makes git work, so it's set up FIRST and never blocks on ssh.
//   - SSH (best-effort): an ed25519 key generated in the sandbox and registered to the account via the token. Only
//     AFTER a successful registration do we write the ssh-config alias (`IdentitiesOnly yes` forces that key), so
//     `git clone ssh://git@<host>/owner/repo` authenticates. Registration needs a key-write permission (github:
//     classic PAT `write:public_key` OR a fine-grained token with "Git SSH keys: write"; gitlab: the api scope).
//   - SSH refused → we DON'T leave a config forcing an unregistered key (that's the `Permission denied (publickey)`
//     trap). Instead a git `insteadOf` rewrite maps `ssh://git@<host>/` and `git@<host>:` onto https, so ssh-form
//     remotes keep working over the https credential, and a warning names how to enable native ssh. The two paths
//     clear each other's artifacts, so a scope-fixed re-add flips back to native ssh.
// Keyed by host, so github.com and a self-hosted gitlab coexist. The key title is fixed so re-apply is idempotent.

const KEY_TITLE = "intentic-sandbox";

export interface GitHost {
    readonly provider: "github" | "gitlab";
    // The ssh + https host and the ssh-config alias (github.com | gitlab.example.com).
    readonly host: string;
    // REST base for the key up/download (https://api.github.com | https://gitlab.example.com/api/v4).
    readonly apiBase: string;
    readonly token: string;
    // The https username the token rides under: github → x-access-token, gitlab → oauth2.
    readonly httpsUser: string;
}

// Map a github/gitlab capability config to its git host. github is fixed; gitlab derives from the instance url.
export const gitHostOf = (config: Extract<CliConfig, { provider: "github" | "gitlab" }>): GitHost =>
    config.provider === "github"
        ? { provider: "github", host: "github.com", apiBase: "https://api.github.com", token: config.token, httpsUser: "x-access-token" }
        : {
              provider: "gitlab",
              host: new URL(config.url).host,
              apiBase: `${config.url.replace(/\/+$/, "")}/api/v4`,
              token: config.token,
              httpsUser: "oauth2",
          };

// The account-key REST calls are the only un-testable seam (network + a live token), so they're injectable; keygen
// and git-config run for real (both are local and available in test envs).
export interface GitAccessDeps {
    readonly uploadKey: (host: GitHost, publicKey: string, title: string) => Promise<void>;
    readonly deleteKey: (host: GitHost, title: string) => Promise<void>;
}

const fileExists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );

const credentialsPath = (): string => join(homedir(), ".git-credentials");

// Upsert the https credential line for this host (rewrites any prior line for the host, e.g. a rotated token) and
// make sure the `store` helper reads it. mode 0600 — it holds the token in cleartext, so the line itself is a
// plain fs write, never a visible command; only the secret-free `git config` runs in the terminal.
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

// Generate the key pair once (stable identity across retries — regenerating would orphan an already-registered
// key) and return its public half. Registration is NOT done here: it's attempted every apply so a scope-fixed
// re-add actually registers instead of the local key's presence masking that it never landed on the account.
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
    const reason = err instanceof Error ? err.message : String(err);
    return [
        `Git access is on and works over HTTPS (ssh-form remotes are routed there too), but registering a native SSH key failed: ${reason}`,
        `Native ssh://git needs ${scopeHint}. Fix the token and re-add, or add this public key to your ${host.provider} account manually:`,
        publicKey,
    ].join("\n");
};

const githubHeaders = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });

const uploadKeyReal = async (host: GitHost, publicKey: string, title: string): Promise<void> => {
    if (host.provider === "github") {
        const response = await fetch(`${host.apiBase}/user/keys`, {
            method: "POST",
            headers: { ...githubHeaders(host.token), "Content-Type": "application/json" },
            body: JSON.stringify({ title, key: publicKey }),
        });
        // 422 = "key is already in use" — the same public key was registered before; treat as success (idempotent).
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
    // 400 = "fingerprint has already been taken" — GitLab's idempotent-success equivalent.
    if (!response.ok && response.status !== 400) {
        throw new Error(`GitLab SSH key upload failed (${response.status}): ${await response.text().catch(() => "")}`);
    }
};

// Best-effort: a stale token or an offline host must not block local teardown, so every failure is swallowed.
// ponytail: matches keys by our fixed title; a user who renamed the key on the account keeps it — acceptable.
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
        // swallow — see comment above.
    }
};

const realDeps: GitAccessDeps = { uploadKey: uploadKeyReal, deleteKey: deleteKeyReal };

// The https base every ssh-form remote for this host is rewritten onto (keyed here so github.com and a self-hosted
// gitlab don't collide). Trailing slash so `git@<host>:owner/repo` and `ssh://git@<host>/owner/repo` both land on
// `https://<host>/owner/repo`, which the ~/.git-credentials line then authenticates.
const rewriteKey = (host: GitHost): string => `url.https://${host.host}/.insteadOf`;

// Route ssh-form remotes over https — the fallback when a native ssh key can't be registered. Two url forms need
// covering; --replace-all seeds a single value (creating the key if absent), --add appends the second, so a
// re-apply stays at exactly two entries (idempotent).
const enableHttpsRewrite = async (host: GitHost, exec: ExecInTerminal): Promise<void> => {
    await exec("git", ["config", "--global", "--replace-all", rewriteKey(host), `git@${host.host}:`]);
    await exec("git", ["config", "--global", "--add", rewriteKey(host), `ssh://git@${host.host}/`]);
};

// Drop the rewrite (native ssh got registered, or teardown). `git config --unset-all` exits 5 when the option
// doesn't exist — nothing to remove, so that lone code is expected; any other failure propagates.
const disableHttpsRewrite = async (host: GitHost, exec: ExecInTerminal): Promise<void> => {
    try {
        await exec("git", ["config", "--global", "--unset-all", rewriteKey(host)]);
    } catch (err) {
        if ((err as { code?: number }).code !== 5) {
            throw err;
        }
    }
};

// Returns undefined when native ssh is wired (key registered), or a warning when registration was refused and
// ssh-form remotes were routed onto https instead. HTTPS is configured first and unconditionally so git works
// regardless of the ssh outcome; the ssh-config alias is written ONLY after a successful registration so we never
// force an unregistered key (the `Permission denied (publickey)` trap). `exec` is the caller's visible terminal
// runner — every git config / ssh-keygen shows in the capability's job session (all argv here is secret-free).
export const setupGitAccess = async (host: GitHost, exec: ExecInTerminal, deps: GitAccessDeps = realDeps): Promise<string | undefined> => {
    await ensureHttpsCredential(host, exec);
    const publicKey = await ensureKeyPair(host, exec);
    try {
        await deps.uploadKey(host, publicKey, KEY_TITLE);
    } catch (err) {
        // Registration refused: don't leave a config forcing the unregistered key — drop any stale alias (keeping
        // the keypair for a later scope-fixed re-add) and route ssh-form remotes over the working https credential.
        await rm(hostConfPath(host.host), { force: true });
        await enableHttpsRewrite(host, exec);
        return sshRegistrationWarning(host, publicKey, err);
    }
    // Registered: native ssh works. Wire the alias and drop any https rewrite left by an earlier failed apply.
    await writeSshHost(host.host, { host: host.host, user: "git", port: 22, identityFile: hostKeyPath(host.host) });
    await disableHttpsRewrite(host, exec);
    return undefined;
};

export const teardownGitAccess = async (host: GitHost, exec: ExecInTerminal, deps: GitAccessDeps = realDeps): Promise<void> => {
    // Nothing was ever set up (git access off / never on) ⇒ no local files and no account key ⇒ no-op, no network.
    if (!(await fileExists(hostKeyPath(host.host)))) {
        return;
    }
    // Best-effort account cleanup first (needs the network + a valid token); local files always go regardless.
    await deps.deleteKey(host, KEY_TITLE);
    await removeSshHost(host.host);
    await rm(`${hostKeyPath(host.host)}.pub`, { force: true });
    await disableHttpsRewrite(host, exec);
    await removeHttpsCredential(host);
};
