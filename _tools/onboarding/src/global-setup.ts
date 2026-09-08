import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { e2eTier } from "@intentic/testing/e2e";
import { dockerAvailable } from "./docker.js";
import { buildImages } from "./images.js";
import { fakeGoogleIdToken, GOOGLE_TOKEN_STORAGE_KEY, seedSession, verifySession } from "./seed.js";
import { startWorld } from "./world.js";
import { STORAGE_STATE, writeWorldFile } from "./world-file.js";

// Stands down instead of failing red when the reason isn't fixable by a person (feature flag off, no Docker), since
// this tier blocks releases. Returns a function to double as the global teardown, since the containers are held in this
// closure and can't survive a move to a separate module.

const tier = e2eTier(`intentic onboarding journey`, { enabledBy: `INTENTIC_E2E_ONBOARDING` });

// Same cert bypass as the Playwright config, for this process's own fetches while waiting on the world.
process.env[`NODE_TLS_REJECT_UNAUTHORIZED`] = `0`;

// Playwright reads storageState from a fixed path before setup runs, so the file must exist even when the tier stands
// down, or specs fail on a missing file instead of skipping.
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
        standDown(`${tier.title}, not asked for (set INTENTIC_E2E_ONBOARDING=1)`);
        return;
    }
    if (!(await dockerAvailable())) {
        standDown(`${tier.title}: this machine has no Docker daemon`);
        return;
    }

    await buildImages();
    const world = await startWorld();

    try {
        // Seeded sign-in, proven live here so a Better Auth upgrade fails with a sentence, not a blank login page.
        const session = await seedSession(world.databaseUrl, world.betterAuthSecret);
        await verifySession(world.apiUrl, session);

        writeStorageState({
            cookies: [
                {
                    name: session.cookieName,
                    value: session.cookieValue,
                    // Same host and scheme as the SPA keeps them same-site, so the cookie rides.
                    domain: new URL(world.apiUrl).hostname,
                    path: `/`,
                    expires: Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60,
                    httpOnly: true,
                    // Https world, so this is the secure `__Secure-`-prefixed cookie the server mints.
                    secure: true,
                    sameSite: `Lax`,
                },
            ],
            // Cached Google credential; the sandbox client won't call a daemon without one, skipping the sign-in gate.
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
