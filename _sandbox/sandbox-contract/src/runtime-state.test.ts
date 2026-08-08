import { describe, expect, it } from "vitest";
import { RUNTIME_DOMAIN_BINDINGS, runtimeBoundQueryKeys, staleRuntimeQueryKeys } from "./runtime-state.js";

describe(`staleRuntimeQueryKeys`, () => {
    it(`maps a pushed domain to the queries it makes stale`, () => {
        expect(staleRuntimeQueryKeys([`terminals`])).toEqual([`terminals`]);
    });

    it(`dedupes across a batch, because one sweep can move several domains at once`, () => {
        // The port sampler publishes both: a dev server binding its port is a new port AND the panel above it
        // turning healthy (panels.ts reads health off the listening sockets). Order is the TABLE's, not the
        // frame's, so a repeated domain and a reordered frame produce the same list.
        expect(staleRuntimeQueryKeys([`ports`, `panels`, `ports`])).toEqual([`panels`, `apps`, `ports`]);
    });

    it(`ignores a domain this build has never heard of`, () => {
        // A daemon newer than the browser names domains this table doesn't carry. Refreshing what we understand
        // and dropping the rest beats throwing away the whole frame.
        expect(staleRuntimeQueryKeys([`terminals`, `something-later`])).toEqual([`terminals`]);
    });

    it(`asks for nothing when nothing matched`, () => {
        expect(staleRuntimeQueryKeys([])).toEqual([]);
    });
});

describe(`runtimeBoundQueryKeys`, () => {
    it(`covers every declared domain, since a reconnect is the only recovery for a frame nobody received`, () => {
        expect([...runtimeBoundQueryKeys()].toSorted()).toEqual(
            [...new Set(RUNTIME_DOMAIN_BINDINGS.flatMap((binding) => binding.invalidates))].toSorted(),
        );
    });

    it(`leaves no domain declaring no keys — a domain nothing renders has no reason to be pushed`, () => {
        expect(RUNTIME_DOMAIN_BINDINGS.filter((binding) => binding.invalidates.length === 0)).toEqual([]);
    });
});
