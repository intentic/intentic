import { PROVIDER_BRAND_PATHS } from "@intentic/constants";
import { accessFor, capabilitiesOf, harnessChoosable, limitationsOf, PROVIDER_ACCESS, PROVIDER_VENDOR, PROVIDERS, providerLabel } from "./agent-catalog.js";
import {
    ACCESS_COST,
    cliProxyIdOf,
    MINTED_PROVIDERS,
    mintedVariant,
    mintedVariants,
    NATIVE_PROVIDERS,
    nativeProvidersIn,
    PROVIDER_SPECS,
    providerSpec,
} from "./provider-specs.js";
import { NativeProviderParamSchema } from "../schemas/agent.js";
import { TranslatorAccountsSchema } from "../schemas/providers/plan-limits.js";
import { KeyedProviderSchema } from "../schemas/providers/provider-subscriptions.js";

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
            expect<readonly string[]>(KeyedProviderSchema.options, `${id} is routed but missing from KeyedProvider`).toContain(id);
            expect(Object.keys(TranslatorAccountsSchema.shape), `${id} has no slot in TranslatorAccounts`).toContain(id);
            return;
        }
        if (spec.auth.kind === "minted") {
            expect<readonly string[]>(MINTED_PROVIDERS, `${id} is minted but missing from MINTED_PROVIDERS`).toContain(id);
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
                // Resolve each named variant exactly to itself.
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

test("every provider offers its own default loop, and each offered loop runs a different runtime", () => {
    for (const spec of PROVIDER_SPECS) {
        const offered = Object.entries(spec.loops.offered);
        expect(Object.keys(spec.loops.offered), `${spec.id}'s default loop is not offered`).toContain(spec.loops.default);
        // Two loops on one runtime would be a chip whose positions run the same thing.
        const runtimes = offered.map(([, offer]) => offer?.capabilities.runtime);
        expect(new Set(runtimes).size, `${spec.id} offers two loops on one runtime`).toBe(runtimes.length);
        expect(harnessChoosable(spec.id), spec.id).toBe(offered.length > 1);
    }
});

test("a minted provider runs Claude Code where asked, and Meta's key its own Muse Code by default", () => {
    for (const provider of MINTED_PROVIDERS) {
        expect(capabilitiesOf(provider, "claude-code").runtime, provider).toBe("claude-code");
        expect(capabilitiesOf(provider, "native").runtime, provider).toBe(provider === "meta" ? "muse" : "claude-code");
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

// The desktop app's `?found=claude,codex`: what it found signed in on the computer, read back as providers.
test("a list of ids names known providers once each, in its own order", () => {
    expect(nativeProvidersIn("codex,claude")).toEqual(["codex", "claude"]);
    // Unknown ids, blanks and repeats are dropped rather than refusing the whole list.
    expect(nativeProvidersIn(" claude , ,nope,endpoint/x,claude,gemini")).toEqual(["claude", "gemini"]);
    // A repeated query key, as a router hands it back, and a bare `?found`.
    expect(nativeProvidersIn(["codex", null, "cursor"])).toEqual(["codex", "cursor"]);
    expect(nativeProvidersIn(null)).toEqual([]);
    expect(nativeProvidersIn(undefined)).toEqual([]);
});

// Cursor's own runtime: its project commands are read and published by the daemon, and the owner's replacement prompt
// replaces Cursor's base where the account is entitled to (the fallback for one that is not is the append).
test("cursor publishes its commands and replaces its base prompt", () => {
    const cursor = capabilitiesOf("cursor", "native");
    expect(cursor.runtime).toBe("cursor");
    expect(cursor.commands).toBe(true);
    expect(cursor.instructions).toBe("replace");
});

// What the hook script and the SDK's own seams carry on Cursor's runtime: per-tool cards in `default` mode, the shell in
// the terminal panel, its own skill loader, and a tool list nothing gets past (runtimes/cursor/).
test("cursor holds every mode, a tool list, the terminal panel and its own skills", () => {
    const cursor = capabilitiesOf("cursor", "native");
    expect(cursor.permissions).toBe("modes");
    expect(cursor.terminals).toBe(true);
    expect(cursor.skillDiscovery).toBe("native");
    expect(cursor.toolAllowlist).toBe(true);
    expect(limitationsOf(cursor)).toEqual(["no plugins", "secrets masked in shell output only, not in files the agent reads"]);
});

// Devin runs the ACP floor under its own name: what the floor gained (approvals, questions) it has too, and the effort
// scale it does not advertise stays off.
test("devin is the ACP floor under its own name", () => {
    const devin = capabilitiesOf("devin", "native");
    const floor = capabilitiesOf("some-installed-agent", "native");
    expect(devin.runtime).toBe("devin");
    expect({ ...devin, runtime: floor.runtime }).toEqual(floor);
    expect(devin.permissions).toBe("modes");
    expect(devin.questions).toBe(true);
    expect(devin.effort).toBe(false);
});
