// Compose variant of the setup one-liner: a one-time bootstrap writes `.env` beside the user's compose file,
// then `docker compose up -d`; no tunnel is minted separately. Mirrors connect.sh's image, env, volumes, network
// alias and names, so a sandbox can move between script-managed and compose-managed without losing /work.

import { LOCAL_PORT, PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { ORIGIN_HOST, SANDBOX_CAPABILITIES, sandboxNames } from "@intentic/sandbox-run";

export interface ComposeArgs {
    // The short-lived setup code the platform minted, the only secret-adjacent value in the instructions.
    readonly code: string;
    // The sandbox's public hostname (<slug>.<zone>) the chosen target resolved to.
    readonly hostname: string;
    // Cloudflare API token (own path only): appended to .env, never sent to the platform.
    readonly image: string;
    readonly googleClientId: string;
    // Origin the setup page is served from; mirrors WEB_ORIGIN, shown only when it differs from the hosted default.
    readonly webOrigin: string;
    // Local dev only: the localhost platform origin; production leaves it undefined (api.intentic.dev).
    readonly platformUrl?: string;
}

// Platform API origin (claim, announce); not the web-app origin, which 405s a POST. Mirrors PLATFORM_URL.
const PLATFORM_DEFAULT = `https://api.intentic.dev`;
// Mirrors connect.sh's CLOUDFLARED_IMAGE; the alias and per-sandbox names come from the run contract.

const slugOf = (hostname: string): string => hostname.split(`.`)[0] ?? hostname;
const isLocal = (url: string): boolean => url.includes(`//localhost`) || url.includes(`//127.0.0.1`);

// True when the image reference has an explicit registry host. Mirrors connect.sh's image_has_registry; drives
// pull_policy so a `compose pull` stage skips a local-only image instead of failing.
const imageHasRegistry = (image: string): boolean => {
    const firstSegment = image.split(`/`)[0];
    return image.includes(`/`) && firstSegment !== undefined && /[.:]/.test(firstSegment);
};

// One-time bootstrap run beside the compose file: the claim consumes the setup code and writes per-sandbox
// values as .env lines, then compose starts the sandbox with them.
export const composeBootstrap = (args: ComposeArgs): string => {
    const platform = args.platformUrl ?? PLATFORM_DEFAULT;
    // Local dev only: the dev platform's cert is a repo CA the system doesn't trust (same as connect.sh).
    const claim = `curl -fsS${isLocal(platform) ? `k` : ``} ${platform}/setup/claim -d code=${args.code} > .env`;
    return `${claim}\ndocker compose up -d`;
};

// Compose services/volumes/networks to add to the user's docker-compose.yml. Secrets stay in .env; non-secret
// identity is rendered concretely.
export const composeFile = (args: ComposeArgs): string => {
    const names = sandboxNames(slugOf(args.hostname));
    const dev = args.platformUrl !== undefined;
    // The platform as seen from the container (connect.sh's PLATFORM_URL_CONTAINER rewrite).
    const platform = (args.platformUrl ?? PLATFORM_DEFAULT)
        .replace(`//localhost`, `//host.docker.internal`)
        .replace(`//127.0.0.1`, `//host.docker.internal`);
    return [
        `services:`,
        `    intentic-sandbox:`,
        `        image: ${args.image}`,
        // A registry-less local tag must never be pulled (Docker Hub denies it); the moving `:stable` release always
        // is.
        `        pull_policy: ${imageHasRegistry(args.image) ? `always` : `never`}`,
        `        container_name: ${names.container}`,
        `        init: true`,
        // Capabilities come from SANDBOX_CAPABILITIES; `privileged` stays a user edit since rebuild uses `docker run`.
        `        cap_add: [${SANDBOX_CAPABILITIES.join(", ")}]`,
        `        restart: unless-stopped`,
        // Fresh public resolvers: a just-minted tunnel hostname must not hit a stale NXDOMAIN cache.
        `        dns: [1.1.1.1, 1.0.0.1]`,
        `        extra_hosts: [host.docker.internal:host-gateway]`,
        `        networks:`,
        `            intentic:`,
        // The stable name the tunnel ingress dials (cloudflared resolves it on this shared network).
        `                aliases: [${ORIGIN_HOST}]`,
        `        logging:`,
        `            driver: json-file`,
        `            options: { max-size: 10m, max-file: "3" }`,
        // Loopback shortcut skipping the tunnel; .env carries LOCAL_PORT since the token is unknown; delete if taken.
        `        ports: ["127.0.0.1:\${LOCAL_PORT}:${LOCAL_PORT}"]`,
        `        volumes:`,
        `            - work:/work`,
        `            - history:/history`,
        `            - docker-engine:/var/lib/docker`,
        ...(dev ? [`            - agent-auth:/agent-auth`] : []),
        // Ports, roots, and bind host ride the daemon's defaults; only identity, reachability, and secrets appear here.
        `        environment:`,
        `            CONNECT_TOKEN: \${CONNECT_TOKEN:?run the .env bootstrap first}`,
        `            OWNER_EMAIL: \${OWNER_EMAIL:-}`,
        `            SANDBOX_PUBLIC_URL: https://${args.hostname}`,
        `            PLATFORM_URL: ${platform}`,
        // Interpolated: empty here builds an authorizer serving every route; becomes a var that refuses to start.
        `            GOOGLE_CLIENT_ID: ${args.googleClientId === `` ? `\${GOOGLE_CLIENT_ID:?the web app did not supply a Google client id, reload the setup page}` : args.googleClientId}`,
        // SPA origin for CORS; omitted for the hosted app, required for self-hosted or local-dev, else blocked.
        ...(args.webOrigin === PLATFORM_WEB_ORIGIN ? [] : [`            WEB_ORIGIN: ${args.webOrigin}`]),
        // Ingress edge (INGRESS_URL) dialled with signed SANDBOX_GRANT; names must match ingress-contract.ts. Grant is
        // required, URL is optional (falls back to the daemon's default).
        `            INGRESS_URL: \${INGRESS_URL:-}`,
        `            SANDBOX_GRANT: \${SANDBOX_GRANT:?run the .env bootstrap first}`,
        ...(dev ? [`            AGENT_AUTH_DIR: /agent-auth`] : []),
        `networks:`,
        `    intentic:`,
        `        name: ${names.network}`,
        `volumes:`,
        `    work:`,
        `        name: ${names.workspaceVolume}`,
        `    history:`,
        `        name: ${names.historyVolume}`,
        `    docker-engine:`,
        `        name: ${names.dockerVolume}`,
        ...(dev ? [`    agent-auth:`, `        name: intentic-dev-agent-auth`] : []),
        ``,
    ].join(`\n`);
};
