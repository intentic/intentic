import { capabilitiesOf, NATIVE_PROVIDERS } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
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
