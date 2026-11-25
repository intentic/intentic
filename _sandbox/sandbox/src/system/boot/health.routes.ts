import type { Context } from "hono";
import { PROOF_CHALLENGE_PARAM, PROOF_HEX, PROOF_KEY_PARAM } from "@intentic/sandbox-contract/protocol/doors/loopback-proof";
import type { DaemonHealth } from "@intentic/sandbox-contract/schemas/system";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { signInProofs } from "../../auth/auth-enabled.js";
import { LOOPBACK_LISTENER, listenerOf } from "../../auth/proofs/listener.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { proveSyncHolder } from "../../peers/desktop-sync.js";
import { AT_REST_ACCOUNT_STORE, AT_REST_STORES, atRestActive } from "../../store/encryption/at-rest.js";
import { stateStatus } from "../../store/evolution/state-convergence.js";
import { reachPosture } from "../listeners/reach-posture.js";
import { ioPoolState } from "../resources/loop/io-pool-probe.js";
import { buildInfo } from "./build-info.js";
import { FAVICON_ICO_BASE64 } from "./favicon.generated.js";
import { openInApp } from "./open-in-app.js";
import { profileTraits } from "./profile.js";

// The tab icon (_site/site/scripts/backend-icons.mjs): the lotus in the sandbox green, apart from the site's and the api's.
const FAVICON = Buffer.from(FAVICON_ICO_BASE64, "base64");

type HealthDeps = Pick<Services, "config" | "boot" | "announcer" | "reach" | "auth" | "hosts">;

// A machine agent's challenge answered, on the loopback port alone (netd's listener header, which nothing from outside can
// set): a stranger holding the port could otherwise ask through the public tunnel and hand back what this daemon said.
// Keyed with the digest of the credential the agent is about to present, a host link's or a sync pairing's
// (sandbox-contract protocol/doors/loopback-proof.ts); undefined for anything else, a manifest that cannot be read included.
const proofFor = async (services: HealthDeps, c: Context, sandboxId: string | undefined): Promise<string | undefined> => {
    const challenge = c.req.query(PROOF_CHALLENGE_PARAM) ?? "";
    const key = c.req.query(PROOF_KEY_PARAM) ?? "";
    if (sandboxId === undefined || listenerOf((name) => c.req.header(name)) !== LOOPBACK_LISTENER || !PROOF_HEX.test(challenge) || !PROOF_HEX.test(key)) {
        return undefined;
    }
    try {
        return (await services.hosts.prove(key, sandboxId, challenge)) ?? (await proveSyncHolder(services.config.historyRoot, key, sandboxId, challenge));
    } catch {
        // allow(silent-catch): an unproven answer sends the agent to the public address, which is what an unreadable manifest should do
        return undefined;
    }
};

export const healthRawRoutes = defineRawRoutes((services: HealthDeps) => ({
    // The "is a daemon there" probe every flow uses (launch scripts, /setup, the browser's loopback probe).
    // The sandbox id lets a loopback probe tell this daemon from an unrelated process, though anything on the port can
    // say it: a machine agent about to send a credential asks for `proof` as well (`proofFor`). `boot` tells "not
    // answering" from "still converging".
    // `announce` is the one signal for whether this daemon reached the platform; ic reads it via docker exec. The answer
    // is the contract's DaemonHealth, which every reader parses with its loose twin, DaemonHealthReadingSchema.
    "GET /health": async (c) => {
        const sandboxId = sandboxIdFromToken(services.config.connectToken);
        const health: DaemonHealth = {
            ok: true,
            sandboxId,
            // Which posture answers (platform/profile.ts); needed before any authenticated read.
            profile: services.config.sandbox.profile,
            boot: services.boot.progress(),
            // Whether an update's state conversions are still uncommitted (store/evolution/state-convergence.ts); the host rolls
            // the update back when they stay open, so this rides the same probe as `boot`.
            state: stateStatus(),
            announce: services.announcer.status(),
            // Whether this sandbox's public address answers, probed by the box itself.
            reach: services.reach.status(),
            // How the world reaches here: a dialed tunnel, or loopback only.
            reachedBy: reachPosture({
                url: services.config.ingress.url,
                grant: services.config.sandbox.grant,
                frontDoor: profileTraits(services.config).extraListeners,
            }).by,
            // Which build answers (version, source commit, build time), so "is the fix live?" is one read.
            build: buildInfo(),
            atRestEncryption: { active: atRestActive(), stores: atRestActive() ? [...AT_REST_STORES, AT_REST_ACCOUNT_STORE] : [] },
        };
        // Whether libuv's thread pool answers (system/resources/loop/io-pool-probe.ts): one held by a hung network mount
        // stalls every file read while this route, served on the loop, still answers.
        const ioPool = ioPoolState();
        if (ioPool !== undefined) {
            health.ioPool = ioPool;
        }
        // Which proofs open a session here, so an editor knows before signing in whether this daemon takes the platform's
        // identity assertion. Absent on a loopback daemon, which asks for no proof at all.
        if (services.auth !== undefined) {
            health.signIn = { proofs: signInProofs(services.config) };
        }
        const proof = await proofFor(services, c, sandboxId);
        if (proof !== undefined) {
            health.proof = proof;
        }
        return c.json(health);
    },
    // A browser opening this sandbox's own address lands in the app on it (system/boot/open-in-app.ts).
    "GET /": (c) => openInApp(services.config, c),
    "GET /favicon.ico": (c) => c.body(FAVICON, 200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=604800, immutable" }),
}));
