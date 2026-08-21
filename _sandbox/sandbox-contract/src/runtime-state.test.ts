import { describe, expect, it } from "vitest";
import { RUNTIME_DOMAIN_BINDINGS, runtimeBoundQueryKeys, staleRuntimeQueryKeys } from "./runtime-state.js";

describe(`staleRuntimeQueryKeys`, () => {
    it(`maps a pushed domain to the queries it makes stale`, () => {
        expect(staleRuntimeQueryKeys([`terminals`])).toEqual([[`terminals`]]);
    });

    it(`dedupes across a batch, because one sweep can move several domains at once`, () => {
        // The port sampler publishes both: a dev server binding its port is a new port AND the panel above it
        // turning healthy (panels.ts reads health off the listening sockets). Order is the TABLE's, not the
        // frame's, so a repeated domain and a reordered frame produce the same list.
        expect(staleRuntimeQueryKeys([`ports`, `panels`, `ports`])).toEqual([[`panels`], [`apps`], [`ports`]]);
    });

    it(`ignores a domain this build has never heard of`, () => {
        // A daemon newer than the browser names domains this table doesn't carry. Refreshing what we understand
        // and dropping the rest beats throwing away the whole frame.
        expect(staleRuntimeQueryKeys([`terminals`, `something-later`])).toEqual([[`terminals`]]);
    });

    it(`names a NESTED key whole, so a domain can refresh one family without its siblings`, () => {
        // The review is filed under ["git","changes"] and the commit log under ["git","log"]. A landing's drafted
        // message belongs to the first and has nothing to say about the second, which is the case the single
        // segment this table used to carry could not express.
        expect(staleRuntimeQueryKeys([`landings`])).toEqual([[`git`, `changes`]]);
    });

    it(`asks for nothing when nothing matched`, () => {
        expect(staleRuntimeQueryKeys([])).toEqual([]);
    });
});

describe(`runtimeBoundQueryKeys`, () => {
    it(`covers every declared domain, since a reconnect is the only recovery for a frame nobody received`, () => {
        // Compared as joined paths: the assertion is about which keys are covered, and two equal paths are two
        // different arrays.
        const joined = (keys: readonly (readonly string[])[]): string[] => [...new Set(keys.map((key) => key.join(`/`)))].toSorted();
        expect(joined(runtimeBoundQueryKeys())).toEqual(joined(RUNTIME_DOMAIN_BINDINGS.flatMap((binding) => binding.invalidates)));
    });

    it(`leaves no domain declaring no keys: a domain nothing renders has no reason to be pushed`, () => {
        expect(RUNTIME_DOMAIN_BINDINGS.filter((binding) => binding.invalidates.length === 0)).toEqual([]);
    });
});
