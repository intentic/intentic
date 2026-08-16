import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mintCertificate } from "./certs.js";
import { createNetwork, IPS, isRunning, logsOf, removeContainer, removeNetwork, startContainer, sweepStrays } from "./containers.js";
import { dockerAvailable, freePort, HOST, plainUrlFor, requireLoopback, urlFor } from "./docker.js";
import { IMAGES } from "./images.js";

/* THE HALF OF THE WORLD EVERY ONBOARDING PATH SHARES: postgres, the stand-in model, the platform api, and the
 * SPA. What differs between the four paths a user can take is only how they end up with a connected sandbox —
 * so that is a provisioner, and this is everything underneath it, stood up once.
 *
 * The api and the SPA are the BRANCH's images (images.ts), because a gate that tests the last release is not a
 * gate. Everything else is a published image pinned the way the rest of the repository pins them.
 */

// Pinned the way the self-hosted platform's compose file pins it — the same database this product is run on.
/* The SPA is served through a TLS front rather than straight off its own image.
 *
 * The image serves plain http on 80 and is fronted by a TLS terminator in production; here that terminator is
 * this container. It exists because the api MUST be https (certs.ts says why) and same-site comparison
 * includes the scheme — so an http SPA calling an https api would be cross-site, and the session cookie would
 * stop riding. The product's own nginx still serves every byte; this only wraps it.
 */
const NGINX_IMAGE = `nginx:1.30.4-alpine3.24@sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46`;

const TLS_FRONT_CONF = `server {
    listen 443 ssl;
    ssl_certificate /tls/cert.pem;
    ssl_certificate_key /tls/key.pem;
    location / {
        proxy_pass http://web:80;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
`;

const POSTGRES_IMAGE = `postgres:18.4-alpine3.24@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`;

// Not secrets: this database exists for the length of one run, on a network of its own.
const DB = { user: `app`, password: `app`, name: `app` } as const;

/* The trial's switch. Any non-empty value turns it ON — the platform reads it as a pool of keys to spend, and
 * the stand-in upstream accepts any key not in its refusal list, so the value only has to be a value. The trial
 * is OFF by default in this product, which is exactly why the world has to say this: without it every model
 * list is empty and the journey's last step has nothing to send to.
 */
const TRIAL_KEY = `onboarding-trial-key`;
/* The hub's admin token is ALSO the switch that decides whether this platform mints addresses at all: without
 * it every setup code is refused and no installer path reaches its second step. `.test` is an RFC 2606
 * reserved TLD — resolvable by nobody, so a run that accidentally reaches for a real address fails loudly
 * instead of leaking traffic. */
const ZROK_ADMIN_TOKEN = `onboarding-zrok-admin`;
export const SANDBOX_ZONE = `sbx.onboarding.test`;
export const TRIAL_MODEL = `fake-flash-latest`;
// What the journey asserts it read on screen. Distinctive enough that no UI copy could be mistaken for it.
export const TRIAL_REPLY = `The onboarding journey reached the model.`;

export interface World {
    readonly apiUrl: string;
    /** The platform api as a container on ITS OWN network reaches it — what the compose bootstrap curls. */
    readonly apiHostUrl: string;
    readonly webUrl: string;
    readonly databaseUrl: string;
    readonly networkName: string;
    /** The api as a CONTAINER reaches it — what a provisioned sandbox is told to announce to. */
    readonly apiInternalUrl: string;
    readonly betterAuthSecret: string;
    stop(): Promise<void>;
}

/* Wait for a service to answer, and give up the moment waiting has stopped being useful.
 *
 * Bounded, naming what it waited for and what it last saw — every wait in this package does, because a gate
 * that blocks a release has to be fixable and a timeout with no subject is the opposite of that. `container`
 * is what makes the budget generous without being slow: an exited container is checked for on every poll and
 * reported immediately with its log, so a crash reads as a crash instead of as a service that "never started".
 */
export const waitForHttp = async (url: string, what: string, timeoutMs: number, container?: string): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let last = `never attempted`;
    const tail = async (): Promise<string> => (container === undefined ? `` : `\n--- ${container} ---\n${await logsOf(container)}`);
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
            if (response.status < 500) {
                return;
            }
            last = `HTTP ${response.status}`;
        } catch (error) {
            last = error instanceof Error ? error.message : String(error);
        }
        if (container !== undefined && !(await isRunning(container))) {
            throw new Error(`${what} exited before it answered at ${url} — last attempt: ${last}${await tail()}`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    throw new Error(`${what} never answered at ${url} within ${Math.round(timeoutMs / 1000)}s — last attempt: ${last}${await tail()}`);
};

export const startWorld = async (): Promise<World> => {
    if (!(await dockerAvailable())) {
        throw new Error(`the onboarding tier needs a Docker daemon and found none`);
    }
    // Whatever a killed run left behind, before this one takes the names and the subnet.
    await sweepStrays();

    const run = randomBytes(4).toString(`hex`);
    const networkName = `intentic-onboarding-${run}`;
    const names = {
        postgres: `intentic-onboarding-postgres-${run}`,
        upstream: `intentic-onboarding-upstream-${run}`,
        zrok: `intentic-onboarding-zrok-${run}`,
        api: `intentic-onboarding-api-${run}`,
        web: `intentic-onboarding-web-${run}`,
        webtls: `intentic-onboarding-webtls-${run}`,
    };
    const [dbPort, upstreamPort, zrokPort, apiPort, webPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);

    const started: string[] = [];
    const stop = async (): Promise<void> => {
        // `ONBOARDING_KEEP=1` leaves the whole world up, for reading a container's log after a failure.
        if (process.env[`ONBOARDING_KEEP`] === `1`) {
            return;
        }
        // Reverse order, and never throwing: a teardown that fails hides whatever the run was reporting.
        for (const name of started.toReversed()) {
            await removeContainer(name);
        }
        await removeNetwork(networkName);
    };

    try {
        await createNetwork(networkName);

        await startContainer({
            name: names.postgres,
            image: POSTGRES_IMAGE,
            network: networkName,
            ip: IPS.postgres,
            alias: `postgres`,
            env: { POSTGRES_DB: DB.name, POSTGRES_USER: DB.user, POSTGRES_PASSWORD: DB.password },
            ports: { 5432: dbPort },
        });
        started.push(names.postgres);

        /* The tier's one environmental requirement, checked once against the first container up — so an
         * environment that cannot meet it says so here rather than as four services that never started. */
        await requireLoopback(dbPort, `postgres`);
        const apiUrl = urlFor(apiPort);
        const webUrl = urlFor(webPort);
        const tls = await mintCertificate();

        await startContainer({
            name: names.upstream,
            image: IMAGES.upstream,
            network: networkName,
            ip: IPS.upstream,
            alias: `upstream`,
            env: { FAKE_UPSTREAM_MODELS: TRIAL_MODEL, FAKE_UPSTREAM_REPLY: TRIAL_REPLY },
            ports: { 8099: upstreamPort },
        });
        started.push(names.upstream);
        await waitForHttp(`${plainUrlFor(upstreamPort)}/health`, `the stand-in model`, 60_000, names.upstream);

        await startContainer({
            name: names.zrok,
            image: IMAGES.zrok,
            network: networkName,
            ip: IPS.zrok,
            alias: `zrok`,
            env: { FAKE_ZROK_ADMIN_TOKEN: ZROK_ADMIN_TOKEN },
            ports: { 8098: zrokPort },
        });
        started.push(names.zrok);
        await waitForHttp(`${plainUrlFor(zrokPort)}/health`, `the stand-in tunnel hub`, 60_000, names.zrok);

        // At least 32 characters, because Better Auth warns below that and a warning in this log is noise
        // between whoever is reading it and the failure they came for.
        const betterAuthSecret = `onboarding-journey-secret-0123456789abcdef`;
        await startContainer({
            name: names.api,
            image: IMAGES.api,
            network: networkName,
            ip: IPS.api,
            alias: `api`,
            env: {
                DATABASE_URL: `postgresql://${DB.user}:${DB.password}@postgres:5432/${DB.name}`,
                BETTER_AUTH_SECRET: betterAuthSecret,
                // Both are BROWSER-facing, so both carry the outside addresses even though this is a container.
                API_URL: apiUrl,
                WEB_ORIGIN: webUrl,
                // The trial, switched on. Its base ends in `/openai` so the platform derives the native model
                // listing beside it — the discovery path the stand-in exists to feed.
                TRIAL_KEYS: TRIAL_KEY,
                TRIAL_BASE_URL: `http://upstream:8099/v1beta/openai`,
                TRIAL_MODELS: TRIAL_MODEL,
                /* The tunnel fabric, which is what lets the wizard mint a setup code at all. The platform
                 * reaches the hub over the run's own network; the SANDBOX is on a network of its own (the
                 * compose file makes it) and reaches the same hub through the docker host, which is the same
                 * split the two endpoints exist for on a real deployment. */
                ZROK_ADMIN_TOKEN,
                ZROK_API_ENDPOINT: `http://zrok:8098`,
                ZROK_AGENT_ENDPOINT: `http://host.docker.internal:${zrokPort}`,
                ZROK_ZONE: SANDBOX_ZONE,
                // SECRETS_KEY stays unset so a sandbox's connect token is stored in plain text — the seed and
                // the provisioners read it back, exactly as the browser tier's stack does.
                LOG_PRETTY: `false`,
                // The api serves its own TLS, exactly as a dev run does. Nothing verifies this pair — see certs.ts.
                API_HTTPS_KEY: `/tls/key.pem`,
                API_HTTPS_CERT: `/tls/cert.pem`,
            },
            mounts: { [tls.dir]: `/tls` },
            ports: { 6480: apiPort },
        });
        started.push(names.api);
        /* Generous, because this is not waiting for a boot. The image applies every migration in the repository
         * to an empty database before it serves a single request, and then proves the result matches the schema
         * it was compiled against — on a cold run that is minutes, and all of it is work the image is supposed
         * to be doing. The ceiling is here to catch a hang. */
        await waitForHttp(`${apiUrl}/api/auth/ok`, `the platform api`, 420_000, names.api);

        await startContainer({
            name: names.web,
            image: IMAGES.web,
            network: networkName,
            ip: IPS.web,
            alias: `web`,
            // Substituted into the served env.js at container start — the api origin the SPA calls.
            env: { API_URL: apiUrl },
        });
        started.push(names.web);

        const confPath = join(tls.dir, `front.conf`);
        await writeFile(confPath, TLS_FRONT_CONF, `utf8`);
        await startContainer({
            name: names.webtls,
            image: NGINX_IMAGE,
            network: networkName,
            ip: IPS.webtls,
            alias: `webtls`,
            mounts: { [tls.dir]: `/tls`, [confPath]: `/etc/nginx/conf.d/default.conf` },
            ports: { 443: webPort },
        });
        started.push(names.webtls);
        await waitForHttp(webUrl, `the web app`, 60_000, names.webtls);

        return {
            apiUrl,
            /* What a container elsewhere on this machine curls. The compose bootstrap runs on the "user's"
             * side of the fence, so it reaches the platform through the docker host exactly as a real one
             * does. The wizard only writes a local platform into that command when the api is served on
             * loopback, which this tier's addressing already guarantees (docker.ts). */
            apiHostUrl: `https://host.docker.internal:${apiPort}`,
            webUrl,
            databaseUrl: `postgresql://${DB.user}:${DB.password}@${HOST}:${dbPort}/${DB.name}`,
            networkName,
            apiInternalUrl: `http://api:6480`,
            betterAuthSecret,
            stop,
        };
    } catch (cause) {
        await stop();
        throw cause;
    }
};
