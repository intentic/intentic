import type { DaemonHealth } from "@intentic/sandbox-contract/schemas/system";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { signInProofs } from "../../auth/auth-enabled.js";
import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { AT_REST_ACCOUNT_STORE, AT_REST_STORES, atRestActive } from "../../store/encryption/at-rest.js";
import { stateStatus } from "../../store/evolution/state-convergence.js";
import { reachPosture } from "../listeners/reach-posture.js";
import { buildInfo } from "./build-info.js";
import { FAVICON_ICO_BASE64 } from "./favicon.generated.js";
import { openInApp } from "./open-in-app.js";
import { profileTraits } from "./profile.js";

// The tab icon (_site/site/scripts/backend-icons.mjs): the lotus in the sandbox green, apart from the site's and the api's.
const FAVICON = Buffer.from(FAVICON_ICO_BASE64, "base64");

export const healthRawRoutes = defineRawRoutes((services: Pick<Services, "config" | "boot" | "announcer" | "reach" | "auth">) => ({
    // The "is a daemon there" probe every flow uses (launch scripts, /setup, the browser's loopback probe).
    // The sandbox id lets a loopback probe confirm it reached this daemon, not an unrelated process; `boot` tells "not
    // answering" from "still converging".
    // `announce` is the one signal for whether this daemon reached the platform; ic reads it via docker exec. The answer
    // is the contract's DaemonHealth, which every reader parses with its loose twin, DaemonHealthReadingSchema.
    "GET /health": (c) => {
        const health: DaemonHealth = {
            ok: true,
            sandboxId: sandboxIdFromToken(services.config.connectToken),
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
        // Which proofs open a session here, so an editor knows before signing in whether this daemon takes the platform's
        // identity assertion. Absent on a loopback daemon, which asks for no proof at all.
        if (services.auth !== undefined) {
            health.signIn = { proofs: signInProofs(services.config) };
        }
        return c.json(health);
    },
    // A browser opening this sandbox's own address lands in the app on it (system/boot/open-in-app.ts).
    "GET /": (c) => openInApp(services.config, c),
    "GET /favicon.ico": (c) => c.body(FAVICON, 200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=604800, immutable" }),
}));
