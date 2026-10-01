import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";

// The sign-in tier's shape, shared by its global setup (which boots it) and its specs (which only read where it came up).
// The setup runs in the runner's process and the specs in workers; what crosses between them is the environment, which
// Playwright hands every worker as the setup left it.

export const REPO = repoRoot(import.meta.url);
export const CACHE_DIR = join(import.meta.dirname, `..`, `.cache`, `signin`);
export const RESULTS_DIR = join(import.meta.dirname, `..`, `.cache`, `signin-results`);

// The web build the tier serves: the artifact the platform image ships (`vite build`, then env.js from
// environment.deployment.ts), not the dev server.
const WEB_PACKAGE = join(REPO, `_editor/web`);
export const WEB_DIST = join(WEB_PACKAGE, `dist`);
export const API_PACKAGE = join(REPO, `_platform/api`);
// The api as this tier boots it; run by bun from the api's own directory, so its workspace imports resolve as its own.
export const API_HARNESS = join(API_PACKAGE, `src`, `e2e`, `browser-api.ts`);

// The pin the platform's compose file, its migrations job and `e2e-billing` all run, so the schema here is production's.
export const POSTGRES_IMAGE = `postgres:18.6-alpine3.24`;

// Set by the global setup; read by the specs through `stackUrls`.
export const ENV_WEB_URL = `SIGNIN_E2E_WEB_URL`;
export const ENV_API_URL = `SIGNIN_E2E_API_URL`;
export const ENV_GOOGLE_KEY = `SIGNIN_E2E_GOOGLE_KEY`;

export const stackUrls = (): { readonly web: string; readonly api: string } => {
    const web = process.env[ENV_WEB_URL];
    const api = process.env[ENV_API_URL];
    if (web === undefined || api === undefined) {
        throw new Error(`the sign-in stack is not up: run this through signin.playwright.config.ts, whose global setup boots it`);
    }
    return { web, api };
};
