import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteAccount, type HubConfig, mintAccount, publicNamespaceToken } from "./hub.ts";
import { accountEmail, apiName, apiOrigin, devPlatformId, webName, webOrigin } from "./naming.ts";
import { isListening } from "./probe.ts";

/* SERVE THE LOCAL DEV PLATFORM ON THE INTERNET — `pnpm dev:public`.
 *
 * A locally-run platform already puts every SANDBOX it manages on the internet (reachability is a hub account,
 * and the hub is a real deployed service). What stays stuck on the developer's machine is the platform pair
 * itself: invite links are built from WEB_ORIGIN (localhost), the SPA calls API_URL (localhost), and Google
 * sign-in only accepts registered origins. This tool closes exactly that gap, the same way a sandbox closes it:
 * one hub account for the dev platform, an agent on this machine, two public names —
 *
 *     https://dev-<id>.<zone>       → the SPA dev server   (https://localhost:47145)
 *     https://api-dev-<id>.<zone>   → the api              (https://localhost:6480)
 *
 * — and then `pnpm dev:light` started with API_URL/WEB_ORIGIN pointing at them, which is all the invite path,
 * CORS and Better Auth ever needed. `<id>` is digested from a seed persisted in this user's own data directory,
 * so the hostnames survive restarts and the Google registration is one-time.
 *
 * The agent sequence is the sandbox entrypoint's, verbatim (docker-entrypoint.sh): `enable --headless` once
 * into a private HOME, `agent start` supervised (the AGENT holds the shares), then per name `create name` +
 * `share public … --name-selection` — with `--insecure` because the dev servers present the repo-CA certificate
 * no system trusts; the PUBLIC certificate is the hub frontend's wildcard either way.
 *
 * What this deliberately does NOT automate: the one-time Google OAuth registration (printed below — Google
 * allows no wildcards), and the real secrets a public origin demands (the api refuses to boot on the
 * .env.example placeholder once API_URL is public; this tool refuses first, with the same words). */

const ZROK_VERSION = `2.0.4`; // Keep in step with the sandbox image (its Dockerfile's ARG ZROK_VERSION).

// The SPA dev server's port, fixed in _editor/web/vite.config.ts (strictPort) — the api's is configurable
// (API_PORT), this one is not.
const WEB_PORT = 47145;

// The .env.example value — serving a public origin on it would mean everyone on the internet can forge sessions.
const PLACEHOLDER_AUTH_SECRET = `replace-me-with-a-32-char-random-string`;

const repoRoot = fileURLToPath(new URL(`../../..`, import.meta.url));

const fail = (message: string): never => {
    console.error(`\ndev:public: ${message}`);
    process.exit(1);
};

// The per-user data directory, beside localhost-https's: OUTSIDE the repository so every clone and worktree on
// this machine shares one identity (the hostnames must not change with the checkout — they are registered on
// the Google client).
const dataDir = ((): string => {
    const home = homedir();
    if (process.platform === `win32`) {
        return join(process.env[`LOCALAPPDATA`] ?? join(home, `AppData`, `Local`), `intentic`, `dev-public`);
    }
    if (process.platform === `darwin`) {
        return join(home, `Library`, `Application Support`, `intentic`, `dev-public`);
    }
    return join(process.env[`XDG_DATA_HOME`] ?? join(home, `.local`, `share`), `intentic`, `dev-public`);
})();

const seedFile = join(dataDir, `seed`);
const accountFile = join(dataDir, `account-token`);
const agentHome = join(dataDir, `home`);
const agentLog = join(dataDir, `agent.log`);
const binDir = join(dataDir, `bin`);

const args = new Set(process.argv.slice(2));
const tunnelOnly = args.delete(`--tunnel-only`);
const reset = args.delete(`--reset`);
if (args.size > 0) {
    fail(`unknown argument ${[...args].join(` `)} — the flags are --tunnel-only and --reset`);
}

// ── Configuration (root .env, loaded by the pnpm script via --env-file-if-exists) ───────────────────────────
const env = (name: string, fallback = ``): string => {
    const value = process.env[name];
    return value === undefined || value === `` ? fallback : value;
};
const hub: HubConfig = {
    endpoint: env(`ZROK_API_ENDPOINT`, `https://zrok2.sbx.intentic.dev`),
    adminToken: env(`ZROK_ADMIN_TOKEN`),
};
// The hub as THIS machine's agent dials it — differs from the platform's view only when the platform sits on
// the hub's LAN, which a dev laptop does not; same fallback the platform applies.
const agentEndpoint = env(`ZROK_AGENT_ENDPOINT`, hub.endpoint);
const zone = env(`ZROK_ZONE`, `sbx.intentic.dev`);
const apiPort = env(`API_PORT`, `6480`);

if (hub.adminToken === ``) {
    fail(
        `ZROK_ADMIN_TOKEN is not set in the root .env — the dev-platform grant is minted with the hub's admin token, the same credential a dev platform needs to grant sandboxes reachability.`,
    );
}
// The same refusal the api makes once API_URL is public (main.ts) — made here first, before the tunnel exists.
if (env(`BETTER_AUTH_SECRET`) === `` || env(`BETTER_AUTH_SECRET`) === PLACEHOLDER_AUTH_SECRET || env(`SECRETS_KEY`) === ``) {
    fail(
        `a public origin refuses dev-grade secrets: set BETTER_AUTH_SECRET (not the .env.example placeholder) and SECRETS_KEY in the root .env — openssl rand -base64 32 for each.`,
    );
}

/* ── Nothing may already hold the ports the tunnel will publish ──────────────────────────────────────────────
 * A dev platform already running was started with localhost origins, and the tunnel would publish THAT — the
 * api this tool starts would die on EADDRINUSE inside a wall of vite output while the public address kept
 * answering from the old process. The only visible symptom is every minted link (invite mail first) still
 * saying localhost, which is indistinguishable from this tool not working at all. See probe.ts. */
const busy = (await Promise.all([Number(apiPort), WEB_PORT].map(async (port: number) => ((await isListening(port)) ? port : undefined)))).filter(
    (port): port is number => port !== undefined,
);
if (busy.length > 0) {
    fail(
        `something is already serving on ${busy.join(` and `)} — almost certainly a \`pnpm dev\` from an earlier session. Stop it first: it was started with localhost origins, and publishing it would keep sending invite links (and every other minted link) to localhost while the public address looked healthy.`,
    );
}

// ── The grant: seed → id → names, account minted once and cached ────────────────────────────────────────────
if (reset && existsSync(seedFile)) {
    // Revoke on the hub BEFORE forgetting locally — the seed is the only way to name the account.
    const staleId = devPlatformId(readFileSync(seedFile, `utf8`).trim());
    await deleteAccount(hub, accountEmail(staleId, zone));
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`dev:public: previous grant revoked and local state cleared — minting fresh.`);
}
mkdirSync(dataDir, { recursive: true });
if (!existsSync(seedFile)) {
    writeFileSync(seedFile, randomBytes(32).toString(`hex`), { mode: 0o600 });
}
const id = devPlatformId(readFileSync(seedFile, `utf8`).trim());
const origins = { web: webOrigin(id, zone), api: apiOrigin(id, zone) };

if (!existsSync(accountFile)) {
    // The password is random and immediately discarded — the account TOKEN is the credential that matters.
    const { accountToken } = await mintAccount(hub, { email: accountEmail(id, zone), password: randomBytes(24).toString(`base64url`) });
    writeFileSync(accountFile, accountToken, { mode: 0o600 });
}
const accountToken = readFileSync(accountFile, `utf8`).trim();
const namespace = await publicNamespaceToken(hub);

// ── The agent binary: PATH, the cached download, or the release tarball ─────────────────────────────────────
const zrokEnv = {
    ...process.env,
    // A private HOME: the binary keeps its environment (Ziti identity, share registry) in $HOME/.zrok2 with no
    // way to point it elsewhere, and clobbering the developer's real ~/.zrok2 would eat any zrok use of their own.
    HOME: agentHome,
    USERPROFILE: agentHome,
    ZROK2_API_ENDPOINT: agentEndpoint,
    ZROK2_HEADLESS: `true`,
};
const zrok2 = ((): string => {
    if (spawnSync(`zrok2`, [`version`], { stdio: `ignore` }).status === 0) {
        return `zrok2`;
    }
    const cached = join(binDir, process.platform === `win32` ? `zrok2.exe` : `zrok2`);
    if (existsSync(cached)) {
        return cached;
    }
    if (process.platform === `win32`) {
        fail(
            `zrok2 is not on PATH — download the ${ZROK_VERSION} windows release from https://github.com/openziti/zrok/releases/tag/v${ZROK_VERSION} and put zrok2.exe on PATH (or at ${cached}).`,
        );
    }
    return cached;
})();

const downloadZrok2 = async (): Promise<void> => {
    const arch = process.arch === `arm64` ? `arm64` : `amd64`;
    const os = process.platform === `darwin` ? `darwin` : `linux`;
    const url = `https://github.com/openziti/zrok/releases/download/v${ZROK_VERSION}/zrok_${ZROK_VERSION}_${os}_${arch}.tar.gz`;
    console.log(`dev:public: fetching the tunnel agent (${url})…`);
    const response = await fetch(url);
    if (!response.ok) {
        fail(`could not download zrok2 (HTTP ${response.status} for ${url}) — install it on PATH and re-run.`);
    }
    mkdirSync(binDir, { recursive: true });
    const tarball = join(binDir, `zrok2.tgz`);
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
    const extract = spawnSync(`tar`, [`-xzf`, tarball, `-C`, binDir, `zrok2`], { stdio: `inherit` });
    rmSync(tarball, { force: true });
    if (extract.status !== 0) {
        fail(`could not extract zrok2 — install it on PATH and re-run.`);
    }
    chmodSync(zrok2, 0o755);
};
if (zrok2 !== `zrok2` && !existsSync(zrok2)) {
    await downloadZrok2();
}

// A short zrok2 call, output captured — the create/share verbs answer fast; only the agent is long-lived.
const zrokCall = (callArgs: string[]): { ok: boolean; output: string } => {
    const result = spawnSync(zrok2, callArgs, { env: zrokEnv, encoding: `utf8` });
    return { ok: result.status === 0, output: `${result.stdout ?? ``}${result.stderr ?? ``}` };
};

// ── Enable once, then the supervised agent (the agent holds the shares) ─────────────────────────────────────
mkdirSync(agentHome, { recursive: true });
if (!existsSync(join(agentHome, `.zrok2`, `environment.json`))) {
    const enabled = zrokCall([`enable`, accountToken, `--headless`, `--description`, `intentic dev platform`]);
    if (!enabled.ok) {
        fail(
            `zrok2 enable failed against ${agentEndpoint}:\n${enabled.output}\nA stale grant (the hub was rebuilt, the account was deleted) is cleared with: pnpm dev:public --reset`,
        );
    }
}

let shuttingDown = false;
const agentLogStream = createWriteStream(agentLog, { flags: `a` });
let agent: ReturnType<typeof spawn> | undefined;
const startAgent = (): void => {
    agent = spawn(zrok2, [`agent`, `start`], { env: zrokEnv, stdio: [`ignore`, `pipe`, `pipe`] });
    agent.stdout?.pipe(agentLogStream, { end: false });
    agent.stderr?.pipe(agentLogStream, { end: false });
    // The restart loop the sandbox entrypoint runs for the same reason: the overlay drops connections and the
    // agent must simply come back.
    agent.on(`exit`, () => {
        if (!shuttingDown) {
            setTimeout(startAgent, 2_000);
        }
    });
};
startAgent();

// ── The two names, bound to the local dev servers ───────────────────────────────────────────────────────────
// `create name` claims the hostname in the namespace (a failure is a name that is already ours), `share public`
// binds what answers on it. Retried because the agent needs a moment to come up, and "already in use" is this
// machine's own share from a previous run — done either way.
const bindShare = async (label: string, target: string): Promise<void> => {
    let lastRefusal = ``;
    for (let attempt = 0; attempt < 45; attempt += 1) {
        zrokCall([`create`, `name`, label, `--namespace-token`, namespace]);
        const share = zrokCall([`share`, `public`, target, `--backend-mode`, `proxy`, `--insecure`, `--name-selection`, `${namespace}:${label}`]);
        if (share.ok || share.output.includes(`already in use`)) {
            return;
        }
        lastRefusal = share.output.trim();
        // oxlint-disable-next-line eslint/no-await-in-loop -- the retry IS the wait for the agent to come up
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    fail(`could not bind ${label} on the hub:\n${lastRefusal}\nAgent log: ${agentLog}`);
};
await bindShare(webName(id), `https://localhost:${WEB_PORT}`);
await bindShare(apiName(id), `https://localhost:${apiPort}`);

// ── Say where it lives, then hand over to dev ───────────────────────────────────────────────────────────────
console.log(`
dev:public — this checkout is now served on the internet (anyone with the address reaches it):

    web   ${origins.web}
    api   ${origins.api}

One-time, on the dev Google client (the id in environment.local.ts), or sign-in will refuse these origins:
    authorized JavaScript origin:   ${origins.web}
    authorized redirect URI:        ${origins.api}/api/auth/callback/google

Invite links now carry ${origins.web}. An invitee reaches a sandbox only if it holds a reachability
grant (created through this platform with the hub configured) — a loopback-only box stays yours alone.
Agent log: ${agentLog}
`);

const shutdown = (): void => {
    shuttingDown = true;
    agent?.kill();
    process.exit(0);
};
process.on(`SIGINT`, shutdown);
process.on(`SIGTERM`, shutdown);

if (tunnelOnly) {
    console.log(
        `--tunnel-only: keeping the tunnel up. Start dev yourself with:\n\n    API_URL='${origins.api}' WEB_ORIGIN='${origins.web}' pnpm dev:light\n`,
    );
} else {
    const dev = spawn(`pnpm`, [`dev:light`], {
        cwd: repoRoot,
        stdio: `inherit`,
        shell: process.platform === `win32`,
        env: { ...process.env, API_URL: origins.api, WEB_ORIGIN: origins.web },
    });
    dev.on(`exit`, (code) => {
        shuttingDown = true;
        agent?.kill();
        process.exit(code ?? 0);
    });
}
