import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { resolveEngine } from "../engines/engine-resolve.js";
import { resolveOnPath } from "../platform/on-path.js";

/* WHICH `codex` BINARY A TURN DRIVES, and why the daemon resolves it before spawning app-server.
 *
 * The adapter directly spawns `codex app-server --stdio`. @openai/codex-sdk stays as the exact version anchor,
 * but the ~350 MB @openai/codex platform package it pins is pruned from the deployed tree
 * (prepare-image-trees.sh). The one copy of the CLI is the codex PACK's global install at
 * /usr/local/bin/codex, pinned to that exact dependency version, so PATH makes app-server and the agent's own
 * the CLI on PATH provably the same engine.
 *
 * The SDK dependency also provides the DEV fallback's location, and only when its pinned platform package is
 * really there: a checkout that still has the package (a `pnpm install` outside the image) keeps working with
 * no pack installed. */

// The rebuild-fixable state, in the user's terms. "rebuild" is required, it is the word the UI reads to
// route a state to the Environment card, so it has to survive any rewording of this sentence.
export const CODEX_BINARY_MISSING =
    "This sandbox's image doesn't include the Codex CLI yet: rebuild it from the Environment card in Sandbox ▸ Environment to run Codex here.";

/* The tree's own copy, resolved through Node from the SDK's location, not this module's. @openai/codex is the
 * SDK's dependency and not ours, so under pnpm's non-hoisted layout it is only
 * reachable from inside @openai/codex-sdk, and asking the resolver rather than guessing a path is also what
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

/* Resolved per call, not once per daemon, because the ENGINE STORE can move under a running daemon: an owner
 * pressing Update installs a newer codex and the next turn must drive it. The two fallbacks below are still
 * fixed at container start, and the store's own answer is cached for seconds (engines/engine-resolve.ts), so
 * this costs a map lookup on the overwhelmingly common path.
 *
 * ORDER IS STORE, THEN PATH, THEN THE TREE. The store is what an owner asked for explicitly; PATH is the
 * pack's global install, which is the image's floor; the tree copy is the dev checkout's. */
export const codexBinary = async (): Promise<string | undefined> => {
    const stored = await resolveEngine("codex");
    return stored.paths.binPath ?? (await resolveOnPath("codex")) ?? vendoredWrapper();
};
