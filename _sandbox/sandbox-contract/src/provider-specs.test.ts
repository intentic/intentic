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
import { NativeProviderParamSchema } from "./schemas/agent.js";
import { TranslatorAccountsSchema } from "./schemas/plan-limits.js";
import { KeyedProviderSchema } from "./schemas/provider-subscriptions.js";

/* THE SPEC TABLE'S OWN GUARD, and it walks the TABLE rather than a list of names, which is the property that
 * makes it worth having: a provider added tomorrow is covered the day it is added, and one removed takes its
 * assertions with it.
 *
 * What it is for. Ten surfaces used to keep their own enumeration of the same providers; six were
 * `Record<NativeProvider, …>` and could not be short a row, and the other four were arrays and if-chains that
 * silently could. Those four are derived now, and this is what says so: for every provider in the table, every
 * derived list contains it, and every derived answer is one a surface can actually render. */

describe("every provider in the table", () => {
    test.each(PROVIDER_SPECS.map((spec) => ({ id: spec.id, spec })))("$id is described completely", ({ id, spec }) => {
        // The strings a surface prints. Empty is the failure worth naming: each of these lands somewhere a
        // person reads, and a blank one renders as a row with no name rather than as an error anybody notices.
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
        // A brand mark, not the fallback glyph. `brand` is typed against these keys so this cannot fail without
        // someone reaching for a cast, which is exactly when a test earns its place.
        expect(PROVIDER_BRAND_PATHS[spec.brand], `${id} has no brand mark`).toEqual(expect.any(String));
        expect(ACCESS_COST[spec.access.kind], `${id} has an unpriced access kind`).toBeTypeOf("number");
    });

    test.each(PROVIDER_SPECS.map((spec) => ({ id: spec.id, spec })))("$id declares a reachable credential", ({ id, spec }) => {
        if (spec.auth.kind === "translator") {
            // The proxy's own name for it, which is what the daemon addresses its management API by. Reading
            // back undefined here is the `…/model-definitions/undefined` request that used to be possible.
            expect(cliProxyIdOf(id), `${id} is routed but names no CLIProxyAPI provider`).toBe(spec.auth.cliProxy);
            expect(KeyedProviderSchema.options, `${id} is routed but missing from KeyedProvider`).toContain(id);
            expect(Object.keys(TranslatorAccountsSchema.shape), `${id} has no slot in TranslatorAccounts`).toContain(id);
            return;
        }
        if (spec.auth.kind === "minted") {
            expect(MINTED_PROVIDERS, `${id} is minted but missing from MINTED_PROVIDERS`).toContain(id);
            // At least one estate to sign in to, because the head of this list is what a `login/start` that names
            // no variant gets: an empty one is a provider whose connect row has no button that can do anything.
            expect(spec.auth.variants.length, `${id} is minted but offers no estate to sign in to`).toBeGreaterThan(0);
            for (const variant of spec.auth.variants) {
                /* THE TURN URL AND THE CATALOG URL ARE DIFFERENT SURFACES OF ONE ESTATE, and both halves of that
                 * sentence are asserted: same host (a pair that drifted apart would send the catalog to one
                 * vendor and the turn to another), and the turn's base carries NO version segment, because the
                 * harness appends `/v1/messages` itself and a doubled one is a 404 mid-conversation. */
                expect(new URL(variant.anthropicBase).host, `${id}/${variant.id}'s catalog and turn hosts differ`).toBe(
                    new URL(variant.catalogBase).host,
                );
                expect(variant.anthropicBase, `${id}/${variant.id}'s turn base carries a version segment the harness would double`).not.toMatch(
                    /\/v\d+$/,
                );
                expect(variant.label.trim(), `${id}/${variant.id} has no estate label`).not.toBe("");
                // The lookup every surface goes through, rather than the row behind it: an id that names a
                // variant must resolve to that variant and nothing else.
                expect(mintedVariant(id, variant.id), `${id}/${variant.id} does not resolve`).toEqual(variant);
            }
            // An absent variant takes the head of the list, which is what a single-estate provider's connect row
            // always sends and what a `login/start` with no choice on it means.
            expect(mintedVariant(id), `${id}'s default estate is not the head of its list`).toEqual(spec.auth.variants[0]);
            // An estate id nobody declared is NOT the default: falling back would mint a key on one estate and
            // dial it at another, and report the refusal as an authentication problem.
            expect(mintedVariant(id, "no-such-estate"), `${id} defaults an unknown estate instead of refusing`).toBeUndefined();
            return;
        }
        // An oauth provider is served by a handshake this daemon runs; it is in neither routed list.
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
        // The catalog route's param schema is closed over the same vocabulary, so a provider the daemon holds a
        // catalog for but the schema does not name is a 400 on its own models route.
        expect(NativeProviderParamSchema.safeParse({ provider: id }).success, "the catalog route's param").toBe(true);
        // The two lookups every surface goes through, rather than the tables behind them.
        expect(providerSpec(id)?.id).toBe(id);
        expect(accessFor(id)?.requirement).toEqual(expect.any(String));
        expect(providerLabel(id)).not.toBe(id);
    });
});

/* IDS ARE THE KEY EVERYTHING ELSE IS FILED UNDER, so a duplicate is not a cosmetic problem: the derived Records
 * would silently keep the last row, and `providerSpec` the first. */
test("provider ids are unique", () => {
    const ids = PROVIDER_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
});

/* An id may contain neither a slash nor a colon, and both exclusions are load-bearing rather than tidy.
 * `endpoint/<id>` uses the slash to namespace a capability-minted provider, and the picker's pinned selections
 * are `${provider}:${model}` split on the FIRST colon (quick-model.ts), so an id carrying either would parse as
 * something else entirely, silently. */
test("no provider id can be mistaken for an endpoint or a pinned selection", () => {
    for (const spec of PROVIDER_SPECS) {
        expect(spec.id, `${spec.id} would collide with the picker's key shapes`).toMatch(/^[a-z0-9-]+$/);
    }
});

/* THE HARNESS AXIS IS A FACT ABOUT THE TABLE, not a list any surface keeps. A provider whose two runtimes are
 * the same one has nothing to choose, and the chip must not be offered; one with two must offer it. Both
 * directions matter: the version of this that lived in the web named two providers and would have offered
 * Kimi, Meta and Z.ai a switch between two identical loops. */
test("the harness chip is offered exactly where the two harnesses run different loops", () => {
    for (const spec of PROVIDER_SPECS) {
        const native = capabilitiesOf(spec.id, "native");
        const claudeCode = capabilitiesOf(spec.id, "claude-code");
        expect(harnessChoosable(spec.id), `${spec.id}`).toBe(native.runtime !== claudeCode.runtime);
    }
});

/* A MINTED PROVIDER HAS NO NATIVE RUNTIME, by construction rather than by coincidence: it is reached by pointing
 * the Claude Code loop at the vendor's own Anthropic endpoint, and there is no second loop to point anywhere
 * else. A spec row that claimed one would produce a picker chip offering a runtime nothing serves. */
test("a minted provider runs the Claude Code loop on both harnesses", () => {
    for (const provider of MINTED_PROVIDERS) {
        expect(capabilitiesOf(provider, "native").runtime, provider).toBe("claude-code");
        expect(capabilitiesOf(provider, "claude-code").runtime, provider).toBe("claude-code");
    }
});

// An id that names no provider must fall through every lookup rather than resolving to a neighbour's row, which
// is what makes ACP agents and endpoint capabilities safe to name with arbitrary strings.
test("an id that is not a provider resolves to nothing", () => {
    for (const id of ["", "some-installed-agent", "endpoint/ollama", "META", "z.ai"]) {
        expect(providerSpec(id), id).toBeUndefined();
        expect(cliProxyIdOf(id), id).toBeUndefined();
        expect(mintedVariants(id), id).toBeUndefined();
        expect(mintedVariant(id), id).toBeUndefined();
    }
});
