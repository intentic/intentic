import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { e2eTier } from "@intentic/testing/e2e";
import { dockerAvailable } from "./docker.js";
import { buildImages } from "./images.js";
import { fakeGoogleIdToken, GOOGLE_TOKEN_STORAGE_KEY, seedSession, verifySession } from "./seed.js";
import { startWorld } from "./world.js";
import { STORAGE_STATE, writeWorldFile } from "./world-file.js";

/* Everything that must exist before a journey runs, in the order it must exist in, and the two reasons this
 * tier stands down instead of going red.
 *
 * It stands down because it BLOCKS RELEASES. A gate that cannot ship a broken onboarding path is worth having
 * only if the reasons it goes red are always reasons somebody can fix; "this runner has no Docker" is not one
 * of those, and a tier that failed on it would be a tier the team learned to re-run rather than read. So the
 * switch and the daemon are asked first, and a run that has neither writes its reason where every spec repeats
 * it.
 *
 * Returning a function makes it the global teardown as well, which is the only way the world's own stop can be
 * called: the containers are held by this closure, and a closure does not survive the trip to a separate
 * teardown module.
 */

const tier = e2eTier(`intentic onboarding journey`, { enabledBy: `INTENTIC_E2E_ONBOARDING` });

/* Every server in this world rides a certificate minted for the run, which no root store has heard of, and is
 * not meant to (certs.ts). The browser is told to ignore it by the Playwright config; this is the same
 * instruction for the setup process's own fetches, which is how it waits for services and proves the session
 * cookie recipe before any spec runs. */
process.env[`NODE_TLS_REJECT_UNAUTHORIZED`] = `0`;

/* Playwright reads `storageState` from a fixed path in the config, before any of this has run, so the file
 * has to exist even when the tier stands down, or every spec fails on a missing file instead of skipping with
 * the reason. An empty state is the honest content for a run with no signed-in account. */
const writeStorageState = (state: object): void => {
    mkdirSync(dirname(STORAGE_STATE), { recursive: true });
    writeFileSync(STORAGE_STATE, JSON.stringify(state, undefined, 4));
};

const standDown = (reason: string): void => {
    writeWorldFile({ standDown: reason });
    writeStorageState({ cookies: [], origins: [] });
};

export default async (): Promise<(() => Promise<void>) | void> => {
    if (!tier.runs) {
        standDown(`${tier.title} — not asked for (set INTENTIC_E2E_ONBOARDING=1)`);
        return;
    }
    if (!(await dockerAvailable())) {
        standDown(`${tier.title} — this machine has no Docker daemon`);
        return;
    }

    await buildImages();
    const world = await startWorld();

    try {
        /* Sign-in, seeded, and the seam where the real one goes. See seed.ts: the recipe is proven against the
         * running server here, so a Better Auth upgrade fails with a sentence rather than as a blank login
         * page in every journey. */
        const session = await seedSession(world.databaseUrl, world.betterAuthSecret);
        await verifySession(world.apiUrl, session);

        writeStorageState({
            cookies: [
                {
                    name: session.cookieName,
                    value: session.cookieValue,
                    // Both origins share this host and this scheme, which is what keeps the SPA and the api
                    // same-site and the cookie riding (docker.ts and certs.ts say why at length).
                    domain: new URL(world.apiUrl).hostname,
                    path: `/`,
                    expires: Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60,
                    httpOnly: true,
                    // The world is https, so the cookie is the secure, `__Secure-`-prefixed one the server mints.
                    secure: true,
                    sameSite: `Lax`,
                },
            ],
            // The cached Google credential: the browser's sandbox client refuses to call a daemon without one,
            // and a valid cached token means no sign-in gate ever stands in front of the workspace.
            origins: [{ origin: world.webUrl, localStorage: [{ name: GOOGLE_TOKEN_STORAGE_KEY, value: fakeGoogleIdToken() }] }],
        });

        writeWorldFile({
            apiUrl: world.apiUrl,
            apiHostUrl: world.apiHostUrl,
            webUrl: world.webUrl,
            databaseUrl: world.databaseUrl,
            apiInternalUrl: world.apiInternalUrl,
            betterAuthSecret: world.betterAuthSecret,
        });
    } catch (cause) {
        await world.stop();
        throw cause;
    }

    return async () => {
        await world.stop();
    };
};
