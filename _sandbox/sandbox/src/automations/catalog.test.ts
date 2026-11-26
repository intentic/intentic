import { CORE_TRIGGER_SOURCES } from "./catalog.js";

// (2026-11-26) The daemon declares only the sources whose events it emits itself; every template, and every source
// anyone on the internet reaches (bug reports, the Visitor chat), is an extension's, offered while it is on.

test(`the daemon's own sources are the ones it emits, and none of them is reached by strangers`, () => {
    expect(CORE_TRIGGER_SOURCES.map((source) => source.provider)).toEqual([`ci`, `deploys`]);
    expect(CORE_TRIGGER_SOURCES.filter((source) => source.strangers !== undefined)).toEqual([]);
});
