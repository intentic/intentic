import { generateKeyPairSync, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { mintCertificate } from "./certs.js";
import { createNetwork, IPS, isRunning, logsOf, removeContainer, removeNetwork, startContainer, sweepStrays } from "./containers.js";
import { dockerAvailable, freePort, HOST, plainUrlFor, requireLoopback, urlFor } from "./docker.js";
import { IMAGES } from "./images.js";

// Stands up everything every onboarding path shares (postgres, the stand-in model, the platform api, the SPA); only
// getting a connected sandbox differs, which lives in a provisioner. Api and SPA are the branch's own images
// (images.ts); everything else is a pinned published image.

// Pinned to match the self-hosted platform's own compose file.
// SPA fronted by TLS here, not its own image, since the api is https and same-site includes scheme.
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

// Trial switch: any non-empty value turns it on; off by default, so without this every model list is empty.
const TRIAL_KEY = `onboarding-trial-key`;
// A signing key alone hands out setup codes; `.test` is unroutable, so the tunnel dial fails harmlessly.
const INGRESS_SIGNING_KEY = generateKeyPairSync(`ed25519`).privateKey.export({ type: `pkcs8`, format: `pem` }).toString();
export const SANDBOX_ZONE = `sbx.onboarding.test`;
const INGRESS_URL = `https://ingress.${SANDBOX_ZONE}`;
export const TRIAL_MODEL = `fake-flash-latest`;
// What the journey asserts it read on screen; distinctive enough that no UI copy could match it.
export const TRIAL_REPLY = `The onboarding journey reached the model.`;

export interface World {
    readonly apiUrl: string;
    /** The platform api as a container on its own network reaches it; what the compose bootstrap curls. */
    readonly apiHostUrl: string;
    readonly webUrl: string;
    readonly databaseUrl: string;
    readonly networkName: string;
    /** The api address a container reaches; what a provisioned sandbox is told to announce to. */
    readonly apiInternalUrl: string;
    readonly betterAuthSecret: string;
    stop(): Promise<void>;
}

// Waits for a service, naming what it waited for and what it last saw, so a timeout is fixable, not a mystery.
// `container` checks for an exit on every poll, so a crash reports immediately instead of hanging out the full budget.
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
            last = errorMessage(error);
        }
        if (container !== undefined && !(await isRunning(container))) {
            throw new Error(`${what} exited before it answered at ${url}, last attempt: ${last}${await tail()}`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    throw new Error(`${what} never answered at ${url} within ${Math.round(timeoutMs / 1000)}s, last attempt: ${last}${await tail()}`);
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
        api: `intentic-onboarding-api-${run}`,
        web: `intentic-onboarding-web-${run}`,
        webtls: `intentic-onboarding-webtls-${run}`,
    };
    const [dbPort, upstreamPort, apiPort, webPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);

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

        // This tier's one environmental check, done once here, so a bad environment fails with one message, not four.
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

        // At least 32 characters; shorter triggers a Better Auth warning that's noise in this log.
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
                // Both are browser-facing, so both carry the outside address even though this is a container.
                API_URL: apiUrl,
                WEB_ORIGIN: webUrl,
                // Trial switched on; base ends in `/openai` so the platform derives the native model listing too.
                TRIAL_KEYS: TRIAL_KEY,
                TRIAL_BASE_URL: `http://upstream:8099/v1beta/openai`,
                TRIAL_MODELS: TRIAL_MODEL,
                // Reachability: lets the wizard mint a setup code. Platform signs, box carries the grant, nothing is
                // called.
                INGRESS_SIGNING_KEY,
                INGRESS_URL,
                INGRESS_ZONE: SANDBOX_ZONE,
                // SECRETS_KEY stays unset, so a sandbox's connect token is stored in plain text and read back directly.
                LOG_PRETTY: `false`,
                // Api serves its own TLS, as a dev run does; nothing verifies this pair.
                API_HTTPS_KEY: `/tls/key.pem`,
                API_HTTPS_CERT: `/tls/cert.pem`,
            },
            mounts: { [tls.dir]: `/tls` },
            ports: { 6480: apiPort },
        });
        started.push(names.api);
        // Generous: not a boot wait, but every migration applying to an empty db, then a schema-match check.
        await waitForHttp(`${apiUrl}/api/auth/ok`, `the platform api`, 420_000, names.api);

        await startContainer({
            name: names.web,
            image: IMAGES.web,
            network: networkName,
            ip: IPS.web,
            alias: `web`,
            // Substituted into the served env.js at container start, the api origin the SPA calls.
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
            // What a container elsewhere curls; reaches the platform via the docker host, like a real one.
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
