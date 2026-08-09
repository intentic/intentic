import { execFile, spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { LEAF_CRT, LEAF_KEY } from "@intentic-app/localhost-https/paths";
import { repoRoot } from "@intentic/constants/node";
import {
    API_URL,
    BETTER_AUTH_SECRET,
    DAEMON_CONTAINER,
    DAEMON_IMAGE,
    DAEMON_URL,
    DATABASE_URL,
    fakeGoogleIdToken,
    GOOGLE_TOKEN_STORAGE_KEY,
    SEED,
    SESSION_COOKIE_NAME,
    seed,
    signedSessionCookie,
    WEB_URL,
} from "./stack.js";

// Boots the WHOLE stack (compose postgres → migrate → published sandbox daemon in loopback → https API under
// bun → https web under vite), seeds the authenticated world, verifies the minted session cookie against the
// real /api/auth/get-session, and writes the Playwright storage state. Owning it all here (instead of
// playwright's webServer) keeps the ordering explicit: the API needs postgres, the specs need the daemon and
// the seed. Anything already running (dev machine) is reused, not restarted.

const run = promisify(execFile);
const root = repoRoot(import.meta.url);
const cacheDir = join(import.meta.dirname, `.cache`);

// Every server in this stack rides this machine's own localhost cert, whose root CI has no reason to trust.
process.env[`NODE_TLS_REJECT_UNAUTHORIZED`] = `0`;

const up = async (url: string): Promise<boolean> => {
    try {
        return (await fetch(url, { signal: AbortSignal.timeout(3_000) })).status < 500;
    } catch {
        return false;
    }
};

const waitUp = async (url: string, what: string, logHint: string | undefined, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await up(url)) {
            return;
        }
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 1_000));
    }
    throw new Error(`${what} never came up at ${url}${logHint === undefined ? `` : ` — see ${logHint}`}`);
};

// Detached so the whole process group can be torn down (vite/bun spawn children), logging to .cache/<name>.log.
const spawnServer = (name: string, command: string, args: string[], cwd: string, env: Record<string, string>): number => {
    const log = openSync(join(cacheDir, `${name}.log`), `w`);
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: [`ignore`, log, log], detached: true });
    child.unref();
    if (child.pid === undefined) {
        throw new Error(`failed to spawn ${name}`);
    }
    return child.pid;
};

export default async (): Promise<void> => {
    mkdirSync(cacheDir, { recursive: true });
    const state: { apiPid?: number; webPid?: number; daemonStarted?: boolean } = {};

    // Postgres + schema. Compose is idempotent; a CI-provided postgres just makes this a no-op that fails soft.
    await run(`docker`, [`compose`, `up`, `-d`, `--wait`, `postgres`], { cwd: root }).catch(() => undefined);
    await run(`pnpm`, [`--filter`, `@intentic-app/prisma`, `migrate:deploy`], { cwd: root, env: { ...process.env, DATABASE_URL } });

    // The daemon under test: the published sandbox image in loopback (no GOOGLE_CLIENT_ID / PLATFORM_URL —
    // that IS the mode). CONNECT_TOKEN + ZONE make GET /system/sync report an sshHostname, which the desktop-
    // sync card requires before it offers Enable — and that same token is what the daemon's auth floor reads as
    // "reachable from outside", so SANDBOX_ALLOW_UNAUTHENTICATED is the acknowledgement that lets this pair boot
    // (env.config.ts carries the note; without it the daemon exits 78 and this waits out its 180s).
    if (!(await up(`${DAEMON_URL}/health`))) {
        await run(`docker`, [`rm`, `-f`, DAEMON_CONTAINER]).catch(() => undefined);
        await run(`docker`, [
            `run`,
            `-d`,
            `--rm`,
            `--name`,
            DAEMON_CONTAINER,
            `-p`,
            `18787:8787`,
            `-e`,
            `CONNECT_TOKEN=${randomBytes(16).toString(`base64url`)}`,
            `-e`,
            `ZONE=e2e.invalid`,
            `-e`,
            `SANDBOX_ALLOW_UNAUTHENTICATED=1`,
            DAEMON_IMAGE,
        ]);
        state.daemonStarted = true;
        await waitUp(`${DAEMON_URL}/health`, `sandbox daemon (${DAEMON_IMAGE})`, `docker logs ${DAEMON_CONTAINER}`, 180_000);
    }

    // The API (bun, https via the minted cert — the exact dev shape, so the session cookie is __Secure-).
    if (!(await up(`${API_URL}/api/auth/ok`))) {
        state.apiPid = spawnServer(`api`, `bun`, [`./src/main.ts`], join(root, `_platform/api`), {
            DATABASE_URL,
            BETTER_AUTH_SECRET,
            API_URL,
            WEB_ORIGIN: WEB_URL,
            // The minted pair, from the package that mints it. It used to be named by a path inside that
            // package, and the certificate has since moved OUT of the repository to the OS's per-user data
            // directory (localhost-https/paths.mjs says at length why) — leaving this pointing at a file
            // nothing writes any more, so the API died on ENOENT before a single spec ran.
            API_HTTPS_KEY: LEAF_KEY,
            API_HTTPS_CERT: LEAF_CRT,
            LOG_PRETTY: `false`,
        });
        await waitUp(`${API_URL}/api/auth/ok`, `api`, join(cacheDir, `api.log`), 60_000);
    }

    // The web SPA (vite dev, https :47145).
    if (!(await up(WEB_URL))) {
        state.webPid = spawnServer(`web`, `pnpm`, [`--filter`, `@intentic-app/web`, `dev`], root, {});
        await waitUp(WEB_URL, `web`, join(cacheDir, `web.log`), 120_000);
    }

    writeFileSync(join(cacheDir, `stack-state.json`), JSON.stringify(state));

    // Seed, then prove the cookie recipe against the real server BEFORE any spec runs — a Better Auth upgrade
    // that changes the signing fails here with a clear message, not as a blank login page in every spec.
    const { sessionToken } = await seed();
    const cookieValue = signedSessionCookie(sessionToken);
    const response = await fetch(`${API_URL}/api/auth/get-session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` } });
    const session = (await response.json().catch(() => undefined)) as { user?: { email?: string } } | null | undefined;
    if (session?.user?.email !== SEED.email) {
        throw new Error(
            `the seeded session cookie was rejected by ${API_URL}/api/auth/get-session (status ${response.status}) — the Better Auth cookie recipe in stack.ts no longer matches the server`,
        );
    }

    writeFileSync(
        join(cacheDir, `storage-state.json`),
        JSON.stringify({
            cookies: [
                {
                    name: SESSION_COOKIE_NAME,
                    value: cookieValue,
                    domain: `localhost`,
                    path: `/`,
                    expires: Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60,
                    httpOnly: true,
                    secure: true,
                    sameSite: `Lax`,
                },
            ],
            // The cached Google ID token: sandboxClient refuses daemon calls without one, and a valid cached
            // token means no FedCM prompt / sign-in gate ever renders (see stack.ts fakeGoogleIdToken).
            origins: [{ origin: WEB_URL, localStorage: [{ name: GOOGLE_TOKEN_STORAGE_KEY, value: fakeGoogleIdToken() }] }],
        }),
    );
};
