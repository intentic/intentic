import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "@intentic/constants/node";
import { enginePolicyDocument } from "../../engines/engine-policy.js";
import { extensionUpdatesDocument } from "../../extensions/extension-updates.js";
import { extensionUsageDocument } from "../../extensions/extension-usage.js";
import { hostSetupSeededDocument } from "../../hosts/host-seed.js";
import { bundleManifestDocument } from "../../portability/bundle-arrival.js";
import { runnerIdentityDocument } from "../../runners/runner-identity.js";
import { stateModules } from "../shapes/state-modules.js";
import { conversionDigest, type DocumentSpec, documentKey } from "./documents.js";
import { stateDocuments, stateSteps } from "./state-registry.js";
import type { StructuralStep } from "./state-steps.js";

// The registry the boot step converges with and the pre-flight plans with is every definition the source holds: a
// document or step left out of it is one an update would neither convert at boot nor show on its card. Regenerate it
// with `node --import tsx src/store/shapes/write-state-shapes.ts`.

const SOURCE = join(packageRoot(import.meta.url), "src");

// Loaded here, off the assertion clock: every definition the source text holds, as the values its modules export.
const modules = await stateModules(SOURCE);
const exportedBy = async ({ module, name }: { module: string; name: string }): Promise<unknown> =>
    ((await import(pathToFileURL(join(SOURCE, module)).href)) as Record<string, unknown>)[name];
const defined = {
    documents: (await Promise.all(modules.documents.map(exportedBy))) as DocumentSpec[],
    steps: (await Promise.all(modules.steps.map(exportedBy))) as StructuralStep[],
};

test("the registry lists every stored document the source defines, and nothing else", () => {
    const listed = new Set(stateDocuments());
    const missing = modules.documents.filter((_, index) => !listed.has(defined.documents[index] as DocumentSpec));
    expect(missing).toEqual([]);
    expect(stateDocuments().map(documentKey).toSorted()).toEqual(defined.documents.map(documentKey).toSorted());
});

test("the registry lists every structural boot step the source defines, ordered by id", () => {
    expect(stateSteps().map((step) => step.id)).toEqual(defined.steps.map((step) => step.id).toSorted((a, b) => a.localeCompare(b)));
    expect(new Set(stateSteps())).toEqual(new Set(defined.steps));
});

test("no two documents share an address", () => {
    const keys = stateDocuments().map(documentKey);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
});

test("the documents a registry built from the composition's import graph missed are in it", () => {
    // Each is reached only lazily by the daemon, so the pre-flight that loaded the composition planned without them.
    expect(stateDocuments()).toEqual(
        expect.arrayContaining([bundleManifestDocument, runnerIdentityDocument, extensionUpdatesDocument, extensionUsageDocument, enginePolicyDocument, hostSetupSeededDocument]),
    );
});

test("the conversion digest follows the conversion set, not the order or the documents with nothing to convert", () => {
    const documents = stateDocuments();
    const steps = stateSteps();
    const digest = conversionDigest(documents, steps);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(conversionDigest(documents.toReversed(), steps.toReversed())).toBe(digest);
    expect(conversionDigest(documents.filter((spec) => spec.history.length > 0 || spec.movedFrom.length > 0), steps)).toBe(digest);
    expect(conversionDigest(documents, steps.slice(1))).not.toBe(digest);
});
