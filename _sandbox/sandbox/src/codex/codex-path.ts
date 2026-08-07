import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { resolveOnPath } from "../platform/on-path.js";

/* WHICH `codex` BINARY A TURN DRIVES, and why the daemon names it instead of letting the SDK look.
 *
 * @openai/codex-sdk is a thin driver: the JS wrapper stays a dependency, but the ~350 MB @openai/codex platform
 * package it would otherwise spawn is pruned from the deployed tree (prepare-image-trees.sh). The one copy of
 * the CLI is the codex PACK's global install at /usr/local/bin/codex, pinned to the SDK's exact dependency
 * version — so PATH is the answer, and passing it as codexPathOverride is what makes the adapter and the
 * agent's own `codex exec` delegation provably the same engine.
 *
 * Left to itself the SDK resolves @openai/codex/package.json through its own require at CONSTRUCTION time and
 * throws "Unable to locate Codex CLI binaries" when the prune took it — a message about node_modules, for a
 * user whose actual problem is an image without the pack in it.
 *
 * The vendored wrapper is the DEV fallback, and only when it is really there: a checkout that still has the
 * platform package (a `pnpm install` outside the image) keeps working with no pack installed. */

// The rebuild-fixable state, in the user's terms. "rebuild" is load-bearing — it is the word the UI reads to
// route a state to the Environment card — so it has to survive any rewording of this sentence.
export const CODEX_BINARY_MISSING =
    "This sandbox's image doesn't include the Codex CLI yet — rebuild it from the Environment card in Sandbox ▸ Environment to run Codex here.";

/* The tree's own copy, resolved through Node exactly as the SDK resolves it: from the SDK's location, not this
 * module's. @openai/codex is the SDK's dependency and not ours, so under pnpm's non-hoisted layout it is only
 * reachable from inside @openai/codex-sdk — and asking the resolver rather than guessing a path is also what
 * keeps this working in both layouts the daemon runs in (the workspace's shared store in a dev checkout, the
 * self-contained tree in the image).
 *
 * import.meta.resolve for the first hop because the SDK is ESM-only: it publishes no `require` condition, so
 * createRequire().resolve() on it fails ERR_PACKAGE_PATH_NOT_EXPORTED before ever reaching the question.
 *
 * Either resolve throws for the pruned package, which is the ordinary answer here rather than an error; the
 * access check then covers a package directory that survived with its bin removed. */
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

// Resolved once per daemon: PATH is fixed at container start, and adding the pack recreates the container.
let resolved: Promise<string | undefined> | undefined;

export const codexBinary = (): Promise<string | undefined> => {
    resolved ??= (async () => (await resolveOnPath("codex")) ?? (await vendoredWrapper()))();
    return resolved;
};
