import { capabilitiesOf, compareUnrankedModelIds, KEY_PROVIDERS, NATIVE_PROVIDERS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { seedModelsOf } from "../keyed/keyed-provider.js";
import { PROVIDER_MODULES } from "./provider-registry.js";

/* THE REGISTRY'S OWN GUARANTEES, the ones the derived surfaces lean on. The init guard in the registry already
 * throws on a missing or duplicate module; these pin the finer grain a throw message cannot: that each module
 * really serves ITS provider, and that a module with no adapter is backed by a runtime some other module
 * provides rather than by nothing. */

test("exactly one module per native provider", () => {
    // The init guard would have thrown on import if this were false; asserted anyway so the invariant is
    // visible as a green line rather than only as the absence of a crash.
    expect(PROVIDER_MODULES.map((module) => module.id).toSorted()).toEqual([...NATIVE_PROVIDERS].toSorted());
});

/* A module's adapters must be the runtimes the CONTRACT says serve its provider, on some harness. A module
 * contributing an adapter the catalog never routes to is dead weight; one contributing another provider's
 * runtime would let two modules fight over one row. The claude-code runtime is the deliberate exception in
 * reverse: several providers' pairs name it, and the claude module owns it (see the claude module's header). */
test("each module's adapters serve runtimes the contract routes to its provider", () => {
    for (const module of PROVIDER_MODULES) {
        const runtimes = new Set([capabilitiesOf(module.id, "native").runtime, capabilitiesOf(module.id, "claude-code").runtime]);
        for (const adapter of module.adapters) {
            expect(runtimes.has(adapter.runtime), `${module.id} contributes ${adapter.runtime}, which never serves it`).toBe(true);
        }
    }
});

/* A provider with NO adapter of its own is legal exactly when the contract already routes every one of its
 * pairs to a runtime some other module (or the two non-native adapters) provides. Kimi is the case: it runs
 * under the Claude Code loop on either harness. Without this, an empty `adapters` array would be a way to
 * register a provider whose every turn dies looking up a runtime nobody serves. */
test("a module with no adapter is one another module's runtime serves", () => {
    const provided = new Set(PROVIDER_MODULES.flatMap((module) => module.adapters.map((adapter) => adapter.runtime)));
    for (const module of PROVIDER_MODULES.filter((entry) => entry.adapters.length === 0)) {
        for (const harness of ["native", "claude-code"] as const) {
            const runtime = capabilitiesOf(module.id, harness).runtime;
            expect(provided.has(runtime), `${module.id}/${harness} needs ${runtime}, which no module provides`).toBe(true);
        }
    }
});

// Every module answers the two questions every surface iterates for; the optional fields are genuinely
// optional. Shape-level, so a future module hand-built as a partial object literal cannot slip through a cast.
test("every module carries a catalog and a readiness rung", () => {
    for (const module of PROVIDER_MODULES) {
        expect(typeof module.catalog, module.id).toBe("function");
        expect(typeof module.ready, module.id).toBe("function");
    }
});

/* THE KEYED PROVIDERS' MODULES ARE GENERATED, so what is worth pinning is that generating them produced real
 * ones: a mapped list that silently yielded nothing would leave the registry's own guard to catch the gap only
 * as a missing NATIVE_PROVIDERS entry, one layer away from the cause. */
test("every keyed provider has a generated module, and it contributes no adapter", () => {
    for (const provider of KEY_PROVIDERS) {
        const module = PROVIDER_MODULES.find((entry) => entry.id === provider);
        expect(module?.id, `${provider} has no module`).toBe(provider);
        // No native runtime to spawn: the claude module owns the loop that serves these turns, which is the same
        // absence the Kimi test above covers, asserted here from the other direction (by auth kind, not by name).
        expect(module?.adapters, `${provider} contributes an adapter for a runtime it does not own`).toHaveLength(0);
    }
});

/* A KEYED PROVIDER'S SEED FLOOR IS WHAT ITS PICKER SHOWS BEFORE THE VENDOR HAS EVER ANSWERED, and on a fresh
 * sandbox that is the only list there is. Two things have to hold for it to be usable, and both have been got
 * wrong in this repo before on other providers:
 *
 *   it must be NON-EMPTY, or the ladder's bottom rung renders nothing and a turn resolves no model at all;
 *   its head under the catalog's own ordering must be the model a fresh chat should open on, because that head
 *   IS the default (toCatalog takes models[0]), and an alphabetical accident there is how "GPT 5.4 Mini" once
 *   became the Codex default.
 *
 * Asserted through compareUnrankedModelIds rather than by naming ids, so a seed reordered by hand still has to
 * agree with the rule the live catalog will be sorted by a minute later. */
test("every keyed provider seeds a non-empty floor whose head survives the catalog's own ordering", () => {
    for (const provider of KEY_PROVIDERS) {
        const seed = seedModelsOf(provider);
        expect(seed.length, `${provider} seeds nothing`).toBeGreaterThan(0);
        const sorted = [...seed].toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
        expect(sorted[0]?.id, `${provider}'s seed does not lead with the model its ordering would pick`).toBe(seed[0]?.id);
        for (const model of seed) {
            expect(model.label.trim(), `${provider} seeds a model with no label`).not.toBe("");
        }
    }
});
