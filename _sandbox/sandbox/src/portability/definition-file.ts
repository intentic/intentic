import { join } from "node:path";
import type { Services } from "../composition.js";
import { DEFINITION_FILE, deriveDefinition, emitDefinitionToml } from "./definition.js";

/* THE DEFINITION, MATERIALIZED: `sandbox.toml` at the workspace root, written by the daemon and owned by it.
 *
 * The document itself stays DERIVED — definition.ts holds no file in sync and every export still walks the live
 * manifests, which is what keeps drift a computation rather than a bookkeeping duty. What this module adds is a
 * COPY of that derivation on disk, and the copy is downstream of the derive in every direction: nothing here is
 * ever read back as a source, an apply still goes through applyDefinitionItems, and a diff still compares two
 * derivations. Delete the file and the sandbox is unchanged; the next converge writes it again.
 *
 * WHY A COPY IS WORTH HAVING, given the derive is authoritative:
 *
 *   - The agent working in this sandbox can read what the sandbox IS. Until now that answer lived behind an
 *     owner-only HTTP route, so the one participant most likely to need it was the one that could not ask.
 *   - It gives `git log` an answer for "when did this capability appear". definition.ts emits deterministically
 *     precisely so the document can be reviewed, diffed and committed; nothing in the product was committing
 *     one, so the diff the format was designed for had no counterpart to diff against.
 *   - It travels inside the workspace repo. A target that clones `[workspace]` now finds the definition in the
 *     clone rather than only the pointer to it.
 *
 * THE HEADER SAYS IT IS MANAGED, and that marker is why `emitDefinitionToml` takes a flag rather than always
 * writing one: a DOWNLOADED sandbox.toml is the reader's to edit and commit wherever they like, and telling
 * them their edits will be overwritten would be false. Only this copy is overwritten, because only this copy is
 * the daemon's.
 *
 * UNCHANGED BYTES ARE NOT REWRITTEN. The converge runs on a timer as well as on boot, and a write per sweep
 * would churn the file watcher, dirty the Changes review every five minutes, and put a no-op commit in front of
 * anyone reviewing their workspace. The derivation is deterministic, so comparing the emitted string against
 * what is already there is an exact test for "did the sandbox's shape change".
 */

export const definitionFilePath = (root: string): string => join(root, DEFINITION_FILE);

/* Serialized per workspace root, for loaded-skills.ts's reason: the boot converge, an apply's converge and the
 * sweep can overlap, and two interleaved derivations would let the earlier one land last and leave the file
 * describing a sandbox that no longer exists. The stored chain swallows its own failure so one bad pass cannot
 * wedge every later write; the returned promise does not, so a caller that triggered a pass still hears about
 * it. */
const chains = new Map<string, Promise<void>>();

const write = async (services: Services): Promise<void> => {
    const root = services.workspace.root;
    const { definition, omitted } = await deriveDefinition(services);
    const toml = emitDefinitionToml(definition, omitted, { managed: true });
    const path = definitionFilePath(root);
    if ((await services.files.read(path)) === toml) {
        return;
    }
    await services.files.write(path, toml);
};

/* Bring `sandbox.toml` up to date with what this sandbox currently is.
 *
 * Log-and-continue at every call site: a workspace whose definition file is stale or missing is a workspace
 * with one fewer convenience, and no part of the product reads it, so nothing here is worth failing a boot or a
 * request over. */
export const convergeDefinitionFile = (services: Services): Promise<void> => {
    const root = services.workspace.root;
    const next = (chains.get(root) ?? Promise.resolve()).then(() => write(services));
    chains.set(
        root,
        next.catch(() => undefined),
    );
    return next;
};
