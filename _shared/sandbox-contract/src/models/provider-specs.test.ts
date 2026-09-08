import { PROVIDER_BRAND_PATHS } from "@intentic/constants";
import { describe, expect, test } from "vitest";
import { accessFor, capabilitiesOf, harnessChoosable, PROVIDER_ACCESS, PROVIDER_VENDOR, PROVIDERS, providerLabel } from "./agent-catalog.js";
import {
    ACCESS_COST,
    cliProxyIdOf,
    MINTED_PROVIDERS,
    mintedVariant,
    mintedVariants,
    NATIVE_PROVIDERS,
    PROVIDER_SPECS,
    providerSpec,
} from "./provider-specs.js";
import { NativeProviderParamSchema } from "../schemas/agent.js";
import { TranslatorAccountsSchema } from "../schemas/plan-limits.js";
import { KeyedProviderSchema } from "../schemas/provider-subscriptions.js";

// Walks the spec table itself rather than a list of provider names, so a provider added or removed carries its
// assertions with it; every surface's derived list is checked against the table.

describe("every provider in the table", () => {
    test.each(PROVIDER_SPECS.map((spec) => ({ id: spec.id, spec })))("$id is described completely", ({ id, spec }) => {
        // Strings a surface prints; empty renders as a nameless row rather than a visible error.
        for (const [field, value] of Object.entries({
            label: spec.label,
            vendor: spec.vendor,
            accountLabel: spec.accountLabel,
            destination: spec.destination,
            requirement: spec.access.requirement,
            runs: spec.access.runs,
        })) {
            expect(value.trim(), `${id}.${field}`).not.toBe("");
        }
        // brand is typed against these keys, so this only fails if someone reaches for a cast.
        expect(PROVIDER_BRAND_PATHS[spec.brand], `${id} has no brand mark`).toEqual(expect.any(String));
        expect(ACCESS_COST[spec.access.kind], `${id} has an unpriced access kind`).toBeTypeOf("number");
    });

    test.each(PROVIDER_SPECS.map((spec) => ({ id: spec.id, spec })))("$id declares a reachable credential", ({ id, spec }) => {
        if (spec.auth.kind === "translator") {
            // The CLIProxyAPI's own name for this provider, addressed by the daemon's management API.
            expect(cliProxyIdOf(id), `${id} is routed but names no CLIProxyAPI provider`).toBe(spec.auth.cliProxy);
            expect(KeyedProviderSchema.options, `${id} is routed but missing from KeyedProvider`).toContain(id);
            expect(Object.keys(TranslatorAccountsSchema.shape), `${id} has no slot in TranslatorAccounts`).toContain(id);
            return;
        }
        if (spec.auth.kind === "minted") {
            expect(MINTED_PROVIDERS, `${id} is minted but missing from MINTED_PROVIDERS`).toContain(id);
            // The head of this list is what a login/start naming no variant gets; empty means a dead connect button.
            expect(spec.auth.variants.length, `${id} is minted but offers no estate to sign in to`).toBeGreaterThan(0);
            for (const variant of spec.auth.variants) {
                // Catalog and turn share one host (else different vendors); the turn base carries no version segment.
                expect(new URL(variant.anthropicBase).host, `${id}/${variant.id}'s catalog and turn hosts differ`).toBe(
                    new URL(variant.catalogBase).host,
                );
                expect(variant.anthropicBase, `${id}/${variant.id}'s turn base carries a version segment the harness would double`).not.toMatch(
                    /\/v\d+$/,
                );
                expect(variant.label.trim(), `${id}/${variant.id} has no estate label`).not.toBe("");
                // The lookup every surface goes through, not the row behind it: a named variant must resolve to itself
                // only.
                expect(mintedVariant(id, variant.id), `${id}/${variant.id} does not resolve`).toEqual(variant);
            }
            // An absent variant defaults to the list's head: what a single-estate row or a choice-less login/start
            // means.
            expect(mintedVariant(id), `${id}'s default estate is not the head of its list`).toEqual(spec.auth.variants[0]);
            // An unknown estate must not default: it would mint on one estate and dial another, misread as an auth
            // failure.
            expect(mintedVariant(id, "no-such-estate"), `${id} defaults an unknown estate instead of refusing`).toBeUndefined();
            return;
        }
        // An oauth provider is served by a handshake this daemon runs directly; it belongs in neither routed list.
        expect(KeyedProviderSchema.options, `${id} is not routed but appears in KeyedProvider`).not.toContain(id);
        expect(MINTED_PROVIDERS, `${id} is not minted but appears in MINTED_PROVIDERS`).not.toContain(id);
        expect(mintedVariants(id), `${id} is not minted but names estates`).toBeUndefined();
    });

    test.each(PROVIDER_SPECS.map((spec) => ({ id: spec.id })))("$id is in every derived list", ({ id }) => {
        expect(NATIVE_PROVIDERS).toContain(id);
        expect(
            PROVIDERS.map((option) => option.value),
            "the picker's list",
        ).toContain(id);
        expect(Object.keys(PROVIDER_ACCESS), "the access table").toContain(id);
        expect(Object.keys(PROVIDER_VENDOR), "the vendor table").toContain(id);
        // The catalog route's param schema shares this vocabulary, or an untracked provider 400s on its models route.
        expect(NativeProviderParamSchema.safeParse({ provider: id }).success, "the catalog route's param").toBe(true);
        // The two lookups every surface goes through, rather than the tables behind them.
        expect(providerSpec(id)?.id).toBe(id);
        expect(accessFor(id)?.requirement).toEqual(expect.any(String));
        expect(providerLabel(id)).not.toBe(id);
    });
});

test("provider ids are unique", () => {
    const ids = PROVIDER_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
});

test("no provider id can be mistaken for an endpoint or a pinned selection", () => {
    for (const spec of PROVIDER_SPECS) {
        expect(spec.id, `${spec.id} would collide with the picker's key shapes`).toMatch(/^[a-z0-9-]+$/);
    }
});

test("the harness chip is offered exactly where the two harnesses run different loops", () => {
    for (const spec of PROVIDER_SPECS) {
        const native = capabilitiesOf(spec.id, "native");
        const claudeCode = capabilitiesOf(spec.id, "claude-code");
        expect(harnessChoosable(spec.id), `${spec.id}`).toBe(native.runtime !== claudeCode.runtime);
    }
});

test("a minted provider runs the Claude Code loop on both harnesses", () => {
    for (const provider of MINTED_PROVIDERS) {
        expect(capabilitiesOf(provider, "native").runtime, provider).toBe("claude-code");
        expect(capabilitiesOf(provider, "claude-code").runtime, provider).toBe("claude-code");
    }
});

test("an id that is not a provider resolves to nothing", () => {
    for (const id of ["", "some-installed-agent", "endpoint/ollama", "META", "z.ai"]) {
        expect(providerSpec(id), id).toBeUndefined();
        expect(cliProxyIdOf(id), id).toBeUndefined();
        expect(mintedVariants(id), id).toBeUndefined();
        expect(mintedVariant(id), id).toBeUndefined();
    }
});
