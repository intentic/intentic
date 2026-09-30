import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { newGoogleKey } from "./google.js";
import { serveWeb, type WebServer } from "./serve-web.js";
import { API_HARNESS, API_PACKAGE, CACHE_DIR, ENV_API_URL, ENV_GOOGLE_KEY, ENV_WEB_URL, POSTGRES_IMAGE, REPO, WEB_DIST } from "./stack.js";

// Boots the sign-in tier and returns its teardown: Postgres with the migration history replayed, the api harness
// (_platform/api/src/e2e/browser-api.ts) on it, and the web build served beside it. Everything listens on loopback
// inside this process's own machine, and Postgres is reached through testcontainers' host/port mapping, so the tier runs
// inside a CI job container the way `e2e-billing` does (the assumption the browser tier cannot make).
//
// SIGNIN_E2E_DATABASE_URL: a Postgres to use instead of a container (it is migrated, and each spec's person is new).
// SIGNIN_E2E_REUSE_BUILD=1: serve the `dist` already there. Otherwise the web is built first, unless turbo already did
// (`pnpm e2e:signin` depends on `@intentic/web#build`), since a `dist` that merely exists may be another commit's.

const exec = promisify(execFile);

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once(`error`, reject);
        probe.listen(0, `127.0.0.1`, () => {
            // SAFETY: a TCP listener's address is an AddressInfo; only one on a pipe or socket path is a string.
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });

const waitUp = async (url: string, what: string, log: string, child: ChildProcess, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`${what} exited with ${child.exitCode} before answering ${url}; see ${log}`);
        }
        const answered = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
            (response) => response.status < 500,
            () => false,
        );
        if (answered) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${what} never answered ${url} in ${timeoutMs / 1000}s; see ${log}`);
};

const database = async (): Promise<{ readonly url: string; readonly container?: StartedTestContainer }> => {
    const given = process.env[`SIGNIN_E2E_DATABASE_URL`];
    if (given !== undefined && given !== ``) {
        return { url: given };
    }
    const container = await new GenericContainer(POSTGRES_IMAGE)
        .withEnvironment({ POSTGRES_USER: `app`, POSTGRES_PASSWORD: `app`, POSTGRES_DB: `app`, POSTGRES_INITDB_ARGS: `--no-sync` })
        .withExposedPorts(5432)
        // Twice: the entrypoint's temporary init server says it first, the real one second.
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/u, 2))
        .start();
    return { url: `postgresql://app:app@${container.getHost()}:${container.getMappedPort(5432)}/app`, container };
};

const buildWeb = (): void => {
    const underTurbo = process.env[`TURBO_HASH`] !== undefined;
    const reuse = process.env[`SIGNIN_E2E_REUSE_BUILD`] === `1`;
    if ((underTurbo || reuse) && existsSync(join(WEB_DIST, `index.html`))) {
        process.stdout.write(`sign-in tier: serving the web build of ${statSync(join(WEB_DIST, `index.html`)).mtime.toISOString()}\n`);
        return;
    }
    const built = spawnSync(`pnpm`, [`turbo`, `run`, `build`, `--filter=@intentic/web`, `--output-logs=errors-only`, `--ui=stream`], {
        cwd: REPO,
        stdio: `inherit`,
    });
    if (built.status !== 0 || !existsSync(join(WEB_DIST, `index.html`))) {
        throw new Error(`the web app did not build (turbo run build --filter=@intentic/web, exit ${String(built.status)})`);
    }
};

export default async function globalSetup(): Promise<() => Promise<void>> {
    mkdirSync(CACHE_DIR, { recursive: true });
    buildWeb();

    const { url: databaseUrl, container } = await database();
    // The real migration history, replayed the way a deployment replays it.
    await exec(`pnpm`, [`--filter`, `@intentic/prisma`, `migrate:deploy`], { cwd: REPO, env: { ...process.env, DATABASE_URL: databaseUrl } });

    const google = newGoogleKey();
    let web: WebServer | undefined;
    let api: ChildProcess | undefined;
    const teardown = async (): Promise<void> => {
        api?.kill(`SIGTERM`);
        await web?.close();
        await container?.stop();
    };

    try {
        web = await serveWeb();
        const apiPort = await freePort();
        const apiUrl = `http://localhost:${apiPort}`;
        web.pointAt(apiUrl);

        const log = join(CACHE_DIR, `api.log`);
        const out = openSync(log, `w`);
        api = spawn(`bun`, [API_HARNESS], {
            cwd: API_PACKAGE,
            env: {
                ...process.env,
                DATABASE_URL: databaseUrl,
                API_PORT: String(apiPort),
                WEB_ORIGIN: web.origin,
                BETTER_AUTH_SECRET: randomBytes(32).toString(`base64url`),
                SECRETS_KEY: randomBytes(32).toString(`base64url`),
                E2E_GOOGLE_JWKS: JSON.stringify(google.jwks),
                LOG_LEVEL: `info`,
            },
            stdio: [`ignore`, out, out],
        });
        await waitUp(`${apiUrl}/api/auth/ok`, `the api (browser-api.ts)`, log, api, 60_000);

        // What the specs read (stack.ts `stackUrls`): Playwright hands each worker the environment this setup leaves.
        process.env[ENV_WEB_URL] = web.origin;
        process.env[ENV_API_URL] = apiUrl;
        process.env[ENV_GOOGLE_KEY] = google.privatePem;
        process.stdout.write(`sign-in tier: web ${web.origin}, api ${apiUrl} (log ${log})\n`);
    } catch (error) {
        await teardown();
        throw error;
    }
    return teardown;
}
