import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

// Every first-party package exports a `<scope>/src` condition pointing at its .ts source, and the real build
// applies it. Vitest's node environment did not, so this suite asserted against each lib's LAST-BUILT dist:
// widening sandbox.update's `image` to accept null in _platform/api-contract failed the route test here while
// the route itself was already correct, and that dist is hardlinked into the shared checkout, so rebuilding
// it to agree is not a local act. Silent staleness rather than a load error, the worse of the two failures.
//
// It has to be `ssr.resolve`, not the top-level `resolve`: vitest runs the suite through the SSR pipeline,
// which carries its own resolve options. `@intentic-app/*` is the platform scope (api-contract) and
// `@intentic/*` what runs on the user's machine (sandbox-contract, sandbox-run), the api imports from both.
//
// ON EACH PROJECT, not at the top level: a project is its own Vite config, and options stated once above
// `projects` are silently ignored — which here means straight back onto the stale dist. Same reasoning as
// _search/iq/vitest.config.ts.
const ssr = { resolve: { conditions: [`@intentic-app/src`, `@intentic/src`] } };

export default defineConfig({
    test: {
        projects: [
            { ssr, test: UNIT_SUITE },
            { ssr, test: INTEGRATION_SUITE },
        ],
    },
});
