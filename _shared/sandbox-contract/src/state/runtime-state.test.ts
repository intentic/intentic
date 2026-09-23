import { RUNTIME_DOMAIN_BINDINGS, staleRuntimeQueryKeys } from "./runtime-state.js";

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

    it(`reaches an extension's own key, since the board that renders a run is not core's`, () => {
        // The Pipelines board reads ["ci-runs", <sandbox>]; a prefix is what invalidation matches on.
        expect(staleRuntimeQueryKeys([`ci`])).toEqual([[`ci-runs`]]);
    });

    it(`re-reads the engines card on an install's start and end, its only feed`, () => {
        expect(staleRuntimeQueryKeys([`engines`])).toEqual([[`engines`]]);
    });

    it(`re-reads both Activity reads when the log grows or a gateway's status moves`, () => {
        // The feed is ["activity", <sandbox>] and the status ["activity-status", <sandbox>]: two keys, not one prefix.
        expect(staleRuntimeQueryKeys([`activity`])).toEqual([[`activity`], [`activity-status`]]);
    });
});

describe(`RUNTIME_DOMAIN_BINDINGS`, () => {
    it(`leaves no domain declaring no keys: a domain nothing renders has no reason to be pushed`, () => {
        expect(RUNTIME_DOMAIN_BINDINGS.filter((binding) => binding.invalidates.length === 0)).toEqual([]);
    });
});
