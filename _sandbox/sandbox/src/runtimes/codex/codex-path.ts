import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { engineMissing } from "../../agent/providers/provider-module.js";
import { engineBinary } from "../../engines/engine-resolve.js";

// Resolves the `codex` binary a turn spawns as `codex app-server --stdio`. The pack's global install at
// /usr/local/bin/codex is the deployed copy; the SDK's pinned platform package, resolved through @openai/codex-sdk, is
// the dev-checkout fallback (pruned from the image).

export const CODEX_BINARY_MISSING = engineMissing("the Codex CLI", "Codex");

// Resolves @openai/codex's location through @openai/codex-sdk, the only reachable path under pnpm's non-hoisted layout;
// import.meta.resolve first since the SDK is ESM-only.
// A throw here means the package was pruned (expected, not an error); the access check catches a directory that
// survived with its bin removed.
const vendoredWrapper = async (): Promise<string | undefined> => {
    let wrapper: string;
    try {
        const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
        wrapper = join(dirname(sdkRequire.resolve("@openai/codex/package.json")), "bin", "codex.js");
    } catch {
        return undefined;
    }
    return access(wrapper).then(
        () => wrapper,
        () => undefined,
    );
};

// Resolved per call, not cached: the engine store can change under a running daemon (an Update installs a newer codex).
// Order: the store (explicit request), then PATH (the image's pack install), then the tree copy (dev-checkout
// fallback).
export const codexBinary = async (): Promise<string | undefined> => (await engineBinary("codex")) ?? vendoredWrapper();
