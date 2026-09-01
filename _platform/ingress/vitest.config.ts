import { defineConfig } from "vitest/config";
import { INTEGRATION_SUITE, UNIT_SUITE } from "@intentic/testing/vitest";

/* Every first-party package exports a `<scope>/src` condition pointing at its .ts source, and the real build
 * applies it. Vitest's node environment does not, so without this the suites here would assert against
 * @intentic/sandbox-contract's LAST-BUILT dist rather than the code beside them — and this package's whole job
 * is to be the other half of that contract. A grant format or a wire constant changed in `ingress-contract.ts`
 * and not yet rebuilt would leave these tests green about an agreement that no longer holds, which is the one
 * failure this package cannot afford: the daemon and the edge disagreeing is exactly what the contract exists
 * to prevent.
 *
 * It has to be `ssr.resolve`, not the top-level `resolve`: vitest runs the suite through the SSR pipeline,
 * which carries its own resolve options. And it sits ON EACH PROJECT, because a project is its own Vite config
 * and options stated once above `projects` are silently ignored — straight back onto the stale dist. Same
 * reasoning as _platform/api/vitest.config.ts. */
const ssr = { resolve: { conditions: [`@intentic/src`] } };

export default defineConfig({
    test: {
        projects: [
            { ssr, test: UNIT_SUITE },
            { ssr, test: INTEGRATION_SUITE },
        ],
    },
});
