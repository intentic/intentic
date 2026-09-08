import { describe, expect, it } from "vitest";
import { RUNTIME_DOMAIN_BINDINGS, runtimeBoundQueryKeys, staleRuntimeQueryKeys } from "./runtime-state.js";

describe(`staleRuntimeQueryKeys`, () => {
    it(`maps a pushed domain to the queries it makes stale`, () => {
        expect(staleRuntimeQueryKeys([`terminals`])).toEqual([[`terminals`]]);
    });

    it(`dedupes across a batch, because one sweep can move several domains at once`, () => {
        // ports also invalidates apps: the panel above it turns healthy too. Order follows the table, not the input.
        expect(staleRuntimeQueryKeys([`ports`, `panels`, `ports`])).toEqual([[`panels`], [`apps`], [`ports`]]);
    });

    it(`ignores a domain this build has never heard of`, () => {
        expect(staleRuntimeQueryKeys([`terminals`, `something-later`])).toEqual([[`terminals`]]);
    });

    it(`names a NESTED key whole, so a domain can refresh one family without its siblings`, () => {
        // landings maps to ["git","changes"], distinct from ["git","log"] the commit log uses.
        expect(staleRuntimeQueryKeys([`landings`])).toEqual([[`git`, `changes`]]);
    });

    it(`asks for nothing when nothing matched`, () => {
        expect(staleRuntimeQueryKeys([])).toEqual([]);
    });
});

describe(`runtimeBoundQueryKeys`, () => {
    it(`covers every declared domain, since a reconnect is the only recovery for a frame nobody received`, () => {
        // Joined into strings for comparison: two equal arrays are still different object identities.
        const joined = (keys: readonly (readonly string[])[]): string[] => [...new Set(keys.map((key) => key.join(`/`)))].toSorted();
        expect(joined(runtimeBoundQueryKeys())).toEqual(joined(RUNTIME_DOMAIN_BINDINGS.flatMap((binding) => binding.invalidates)));
    });

    it(`leaves no domain declaring no keys: a domain nothing renders has no reason to be pushed`, () => {
        expect(RUNTIME_DOMAIN_BINDINGS.filter((binding) => binding.invalidates.length === 0)).toEqual([]);
    });
});
