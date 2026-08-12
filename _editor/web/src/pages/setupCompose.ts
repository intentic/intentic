/* The docker-compose variant of the setup one-liner: instead of `curl … | sh` (connect.sh) imperatively
 * starting containers, the user adds two services to their own compose file and a one-time bootstrap creates
 * the `.env` beside it. The claim endpoint already answers KEY=value lines — exactly compose's .env format —
 * so the intentic-provided path needs no script at all: claim → .env, `docker compose up -d`. The
 * own-Cloudflare path additionally mints the sandbox tunnel with the bundled CLI (the same `tunnel sandbox`
 * call connect.sh makes), appending the reachability grant (ZROK_*) + SANDBOX_HOSTNAME to the .env.
 *
 * Everything here mirrors connect.sh's `docker run` — image, env set, volumes, network alias, dns, logging —
 * and uses the SAME container/volume/network names (intentic-*-<slug>), so cleanup.sh, the coexistence check,
 * and the workspace data all stay compatible: a sandbox can move between script-managed and compose-managed
 * without losing /work. Keep the two in lockstep. */

import { LOCAL_PORT, PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { ORIGIN_HOST, SANDBOX_CAPABILITIES, sandboxNames } from "@intentic/sandbox-run";

export interface ComposeArgs {
    // The short-lived setup code the platform minted — the only secret-adjacent value in the instructions.
    readonly code: string;
    // The sandbox's public hostname (<slug>.<zone>) the chosen target resolved to.
    readonly hostname: string;
    // The Cloudflare API token (own path only) — appended to .env, never sent to the platform.
    readonly image: string;
    readonly googleClientId: string;
    // The origin the setup page is being served from — the browser the daemon's CORS has to answer. Mirrors
    // connect.sh's WEB_ORIGIN; rendered only when it differs from the hosted default the daemon already assumes.
    readonly webOrigin: string;
    // LOCAL DEV ONLY: the localhost platform origin; production leaves it undefined (api.intentic.dev).
    readonly platformUrl?: string;
}

// The platform's API origin — where the claim (POST /setup/claim) and the daemon's announce land. NOT the
// web-app origin (app.*), which serves only static files and 405s a POST. Mirrors connect.sh's PLATFORM_URL.
const PLATFORM_DEFAULT = `https://api.intentic.dev`;
// Mirrors connect.sh's CLOUDFLARED_IMAGE; the alias and per-sandbox names come from the run contract.

const slugOf = (hostname: string): string => hostname.split(`.`)[0] ?? hostname;
const isLocal = (url: string): boolean => url.includes(`//localhost`) || url.includes(`//127.0.0.1`);

// True when the image reference carries an explicit registry host (the part before the first `/` looks like a
// hostname). Mirrors connect.sh's image_has_registry: a bare `intentic-sandbox:dev` has none, so it can only
// resolve to Docker Hub — where it does not exist. Drives pull_policy so an orchestrator's `docker compose
// pull` stage (Komodo Stacks run one before `up`) SKIPS a local-only image instead of failing on it.
const imageHasRegistry = (image: string): boolean => {
    const firstSegment = image.split(`/`)[0];
    return image.includes(`/`) && firstSegment !== undefined && /[.:]/.test(firstSegment);
};

// The one-time bootstrap, run in the folder holding the compose file: the claim consumes the setup code and
// writes the per-sandbox values (connect token, the reachability grant, the address) as .env lines, and
// compose starts the sandbox with them. Two commands, because nothing has to be provisioned here any more —
// the box enables against the platform's hub itself.
export const composeBootstrap = (args: ComposeArgs): string => {
    const platform = args.platformUrl ?? PLATFORM_DEFAULT;
    // LOCAL DEV ONLY: the dev platform's cert is a repo CA the system doesn't trust (same as connect.sh).
    const claim = `curl -fsS${isLocal(platform) ? `k` : ``} ${platform}/setup/claim -d code=${args.code} > .env`;
    return `${claim}\ndocker compose up -d`;
};

// The compose services/volumes/networks to add to the user's docker-compose.yml. Secrets stay in the .env
// (compose interpolates them); non-secret identity (names, hostname, platform) is rendered concretely.
export const composeFile = (args: ComposeArgs): string => {
    const names = sandboxNames(slugOf(args.hostname));
    const dev = args.platformUrl !== undefined;
    // The platform as seen FROM the container (connect.sh's PLATFORM_URL_CONTAINER rewrite).
    const platform = (args.platformUrl ?? PLATFORM_DEFAULT)
        .replace(`//localhost`, `//host.docker.internal`)
        .replace(`//127.0.0.1`, `//host.docker.internal`);
    return [
        `services:`,
        `    intentic-sandbox:`,
        `        image: ${args.image}`,
        // A registry-less local tag (intentic-sandbox:dev, built by connect.sh from the checkout) must NEVER
        // be pulled — a `compose pull` would get "denied" from Docker Hub. The moving `:stable` release IS
        // pulled every time so the sandbox tracks the newest release (matching connect.sh's always-pull).
        `        pull_policy: ${imageHasRegistry(args.image) ? `always` : `never`}`,
        `        container_name: ${names.container}`,
        `        init: true`,
        // Unprivileged, matching connect.sh's default run — with the same capability posture that run
        // carries, spliced from the one shared definition (@intentic/sandbox-run SANDBOX_CAPABILITIES; see
        // there for what each grant is for). Without it agents' absolute workspace paths reach the shared
        // checkout, so a compose-started sandbox would quietly be the weaker kind. The docker capability's
        // `privileged: true` (its isolated nested engine; the host's Docker socket is never mounted) stays
        // the user's own compose edit — the rebuild flow recreates containers with `docker run`, which
        // would fight a compose-managed one.
        `        cap_add: [${SANDBOX_CAPABILITIES.join(", ")}]`,
        `        restart: unless-stopped`,
        // Fresh public resolvers, so just-minted ssh-<id> tunnel hostnames don't hit a stale NXDOMAIN cache.
        `        dns: [1.1.1.1, 1.0.0.1]`,
        `        extra_hosts: [host.docker.internal:host-gateway]`,
        `        networks:`,
        `            intentic:`,
        // The stable name the tunnel ingress dials (cloudflared resolves it on this shared network).
        `                aliases: [${ORIGIN_HOST}]`,
        `        logging:`,
        `            driver: json-file`,
        `            options: { max-size: 10m, max-file: "3" }`,
        // The loopback shortcut: a browser on THIS machine reaches the daemon here instead of going out to
        // Cloudflare and back. Every other flow asks the image for its run command and the run contract derives
        // this port from the connect token; a compose file is written before that token exists, so the .env
        // bootstrap carries it as LOCAL_PORT. The browser derives the identical port from the token it holds.
        // Delete this line if something else on the machine already holds the port — compose refuses to start
        // the service rather than falling back, and the sandbox works over its tunnel without it.
        `        ports: ["127.0.0.1:\${LOCAL_PORT}:${LOCAL_PORT}"]`,
        `        volumes:`,
        `            - work:/work`,
        `            - history:/history`,
        `            - docker-engine:/var/lib/docker`,
        ...(dev ? [`            - agent-auth:/agent-auth`] : []),
        // Ports, roots, and the bind host all ride the daemon's own defaults (see env.config.ts) — only
        // identity, reachability, and secrets appear here.
        `        environment:`,
        `            CONNECT_TOKEN: \${CONNECT_TOKEN:?run the .env bootstrap first}`,
        `            OWNER_EMAIL: \${OWNER_EMAIL:-}`,
        `            SANDBOX_PUBLIC_URL: https://${args.hostname}`,
        `            PLATFORM_URL: ${platform}`,
        // Interpolated, not a compose variable — the id is public and known here. But it is also the switch that
        // builds the daemon's authorizer: empty, and the sandbox serves every route to anyone who reaches the
        // tunnel. A build whose env.js substitution didn't land would emit a bare `GOOGLE_CLIENT_ID:` and start
        // exactly that daemon, so an empty value becomes a compose var that refuses to start instead. (The daemon
        // refuses too — see requireAuthWhenReachable — this just fails one layer earlier, with the fix named.)
        `            GOOGLE_CLIENT_ID: ${args.googleClientId === `` ? `\${GOOGLE_CLIENT_ID:?the web app did not supply a Google client id — reload the setup page}` : args.googleClientId}`,
        // The SPA origin the daemon emits CORS for. Omitted when it is the hosted app, which env.config already
        // defaults to — but a self-hosted or localhost-dev SPA is a browser the daemon has never heard of, and
        // without this line every call it makes is blocked before the bearer is ever looked at.
        ...(args.webOrigin === PLATFORM_WEB_ORIGIN ? [] : [`            WEB_ORIGIN: ${args.webOrigin}`]),
        // The sandbox's reachability grant on the platform's own hub — the .env bootstrap (the claim) carries
        // all three, and the container's entrypoint enables + shares with them. There is no tunnel SERVICE any
        // more: the agent runs inside the sandbox, which is why this file is one container shorter than it was.
        `            ZROK_TOKEN: \${ZROK_TOKEN:?run the .env bootstrap first}`,
        `            ZROK_API: \${ZROK_API:-}`,
        `            ZROK_NAMESPACE: \${ZROK_NAMESPACE:-}`,
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
