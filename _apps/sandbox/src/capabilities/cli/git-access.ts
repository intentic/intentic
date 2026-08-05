import type { CliConfig } from "@intentic/sandbox-contract";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { directExec, type ExecInTerminal } from "../../terminal/terminal-run.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
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
//
// Half of this state is on a VOLUME and half is not, which is what restoreGitAccess exists for: the keypair and
// the ssh alias live in the managed dir (symlinked onto /history, see linkSshHosts) and survive a container
// recreate, while ~/.gitconfig (the credential helper + the insteadOf rewrite) and ~/.git-credentials are the
// container's own filesystem and do not.

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
// The config is the open cli shape (`provider` + string fields), so token/url are read positionally.
export const gitHostOf = (config: CliConfig): GitHost => {
    // Fields are validated present at add-time (the connector's field spec), so read them positionally.
    const token = config["token"] ?? "";
    if (config.provider === "github") {
        return { provider: "github", host: "github.com", apiBase: "https://api.github.com", token, httpsUser: "x-access-token" };
    }
    const url = config["url"] ?? "";
    return { provider: "gitlab", host: new URL(url).host, apiBase: `${url.replace(/\/+$/, "")}/api/v4`, token, httpsUser: "oauth2" };
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

export const githubHeaders = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" });

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

// Whether the rewrite is in place, asked of git itself rather than read out of ~/.gitconfig — the value can
// arrive through an include, and this is the same resolution the remote will get. An absent key exits 1, which
// execFile rejects on, so "no rewrite" arrives as a rejection rather than as empty output.
const httpsRewriteEnabled = async (host: GitHost): Promise<boolean> =>
    directExec("git", ["config", "--global", "--get-all", rewriteKey(host)]).then(
        ({ stdout }) => stdout.trim() !== "",
        () => false,
    );

// Route ssh-form remotes over https — the fallback when a native ssh key can't be registered. Two url forms need
// covering; --replace-all seeds a single value (creating the key if absent), --add appends the second, so a
// re-apply stays at exactly two entries (idempotent).
const enableHttpsRewrite = async (host: GitHost, exec: ExecInTerminal): Promise<void> => {
    await exec("git", ["config", "--global", "--replace-all", rewriteKey(host), `git@${host.host}:`]);
    await exec("git", ["config", "--global", "--add", rewriteKey(host), `ssh://git@${host.host}/`]);
};

// Drop the rewrite (native ssh got registered, or teardown). Asked first, because `git config --unset-all`
// exits 5 when the option isn't there — and this is the LAST thing a successful add runs, so swallowing that
// code still left the user's terminal ending on a red "✗ exit 5" epitaph for an install that worked. The probe
// is a read (directExec, invisible); only a removal that has something to remove shows up as a command.
const disableHttpsRewrite = async (host: GitHost, exec: ExecInTerminal): Promise<void> => {
    if (!(await httpsRewriteEnabled(host))) {
        return;
    }
    await exec("git", ["config", "--global", "--unset-all", rewriteKey(host)]);
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

// The boot half of setupGitAccess: re-derive only what the container's ephemeral HOME lost — the credential
// helper + the https line, and either the ssh alias (whose ~/.ssh/config Include died with HOME) or the https
// rewrite. Deliberately WITHOUT an account call: a persisted keypair is already registered, so re-uploading it
// on every boot would only pile up dead "intentic-sandbox" keys on the user's account, and a boot that happens
// to have no network yet would misread the failure as "registration refused" and silently drop to https. A
// MISSING keypair is the one case that needs the full apply, upload included — a sandbox that never wired this
// connector up, or whose managed dir wasn't on the volume yet.
export const restoreGitAccess = async (host: GitHost, exec: ExecInTerminal, deps: GitAccessDeps = realDeps): Promise<string | undefined> => {
    if (!(await fileExists(hostKeyPath(host.host)))) {
        return setupGitAccess(host, exec, deps);
    }
    await ensureHttpsCredential(host, exec);
    // The alias survived next to the key ⇒ the key IS on the account (setupGitAccess writes the alias only after
    // a successful upload, and removes it when one is refused). Rewriting it restores the Include; no alias ⇒
    // registration had been refused, so ssh-form remotes go back over the https credential.
    if (await fileExists(hostConfPath(host.host))) {
        await writeSshHost(host.host, { host: host.host, user: "git", port: 22, identityFile: hostKeyPath(host.host) });
        return undefined;
    }
    await enableHttpsRewrite(host, exec);
    return undefined;
};

// Whether this connection's container-local git access is actually in place — BOTH halves of it. The https
// credential line alone is not working git access: the remotes in this workspace are ssh-form
// (`git@<host>:owner/repo`), and those reach the account over one of the two transports setupGitAccess wires —
// the registered key behind its ssh alias, or the insteadOf rewrite that routes them onto the https credential.
// With the credential written and NEITHER route present, `git push` answers `Permission denied (publickey)`
// under a card reading active; that is precisely the state another daemon repointing ~/.ssh/intentic-hosts
// leaves behind (platform/home-owner.ts), and reporting it is how the owner learns to re-add rather than
// reading the failure as the remote's fault. So the status asks for the transport, not just the token.
export const gitAccessWired = async (host: GitHost): Promise<boolean> => {
    const current = await readFile(credentialsPath(), "utf8").catch(() => "");
    if (!current.split("\n").some((entry) => entry.endsWith(`@${host.host}`))) {
        return false;
    }
    // The alias is written only after a successful registration, so its presence claims native ssh — which is
    // only true while the key it names is still there to be offered.
    if (await fileExists(hostConfPath(host.host))) {
        return fileExists(hostKeyPath(host.host));
    }
    return httpsRewriteEnabled(host);
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

// A connector's privileged side effect beyond env + skill, run by cliHandler around the skill write/remove.
// This CANNOT be data (it shells out with the host's credentials + registers account keys), so it stays core,
// keyed by PROVIDER NAME — a connector extension declares the name, the daemon owns what that name is allowed
// to do. Only the git providers have one; every other connector is pure data.
export interface ConnectorHook {
    readonly apply: (config: CliConfig, exec: ExecInTerminal) => Promise<string | undefined>;
    readonly remove: (config: CliConfig, exec: ExecInTerminal) => Promise<void>;
    // What a recreated container has to get back at boot — the connection survives on /work, its side effect on
    // the container's own filesystem does not.
    readonly restore: (config: CliConfig, exec: ExecInTerminal) => Promise<string | undefined>;
}

const gitAccessHook: ConnectorHook = {
    // `git: "on"` sets up git-over-ssh + the https credential; an explicit "off" (or a previously-on connection
    // switched off) tears down so re-applies are idempotent both directions.
    apply: async (config, exec) => {
        const host = gitHostOf(config);
        if (config["git"] === "on") {
            return setupGitAccess(host, exec);
        }
        await teardownGitAccess(host, exec);
        return undefined;
    },
    remove: (config, exec) => teardownGitAccess(gitHostOf(config), exec),
    // Nothing to restore with git access off — the connector is then env + skill, both already on /work.
    restore: async (config, exec) => (config["git"] === "on" ? restoreGitAccess(gitHostOf(config), exec) : undefined),
};

export const CORE_CONNECTOR_HOOKS: Record<string, ConnectorHook> = { github: gitAccessHook, gitlab: gitAccessHook };

// main.ts's boot restore over the manifest — the git counterpart to reconnectVpns: git access dies with the
// container while the connection survives on /work, so every connected provider gets its container-local git
// config back before the first turn (or the owner's first `git pull`) needs it. Best-effort per entry, and
// silent when it works: a failure here degrades one connection, never the daemon, and the capability's own
// status reports the result (gitAccessWired) rather than a boot log nobody reads.
export const restoreConnectorGitAccess = async (capabilities: CapabilitiesStore, logger: { warn: (message: string) => void }): Promise<void> => {
    for (const capability of await capabilities.list()) {
        if (capability.kind !== "cli") {
            continue;
        }
        const hook = CORE_CONNECTOR_HOOKS[capability.config.provider];
        if (hook === undefined) {
            continue;
        }
        try {
            const warning = await hook.restore(capability.config, directExec);
            if (warning !== undefined) {
                logger.warn(`git access ${capability.id}: ${warning}`);
            }
        } catch (error) {
            logger.warn(`git access ${capability.id}: could not restore: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
};
