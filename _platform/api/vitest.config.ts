import { defineConfig } from "vitest/config";

export default defineConfig({
    // Every first-party package exports a `<scope>/src` condition pointing at its .ts source, and the real build
    // applies it. Vitest's node environment did not, so this suite asserted against each lib's LAST-BUILT dist:
    // widening sandbox.update's `image` to accept null in _platform/api-contract failed the route test here while
    // the route itself was already correct, and that dist is hardlinked into the shared checkout, so rebuilding
    // it to agree is not a local act. Silent staleness rather than a load error — the worse of the two failures.
    //
    // It has to be `ssr.resolve`, not the top-level `resolve`: vitest runs the suite through the SSR pipeline,
    // which carries its own resolve options. `@intentic-app/*` is the platform scope (api-contract) and
    // `@intentic/*` what runs on the user's machine (sandbox-contract, sandbox-run) — the api imports from both.
    ssr: { resolve: { conditions: [`@intentic-app/src`, `@intentic/src`] } },
    test: {
        include: ["./src/**/*.test.ts"],
        environment: "node",
    },
});
