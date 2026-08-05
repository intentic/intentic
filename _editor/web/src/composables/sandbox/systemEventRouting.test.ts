/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { daemonRebuilt, sandboxQueryPredicate, workspaceReplaced } from "./systemEventRouting";

describe(`workspaceReplaced`, () => {
    beforeEach(() => localStorage.clear());

    it(`accepts a first sighting without claiming a replacement`, () => {
        expect(workspaceReplaced(`sbx-1`, `ws-a`)).toBe(false);
    });

    it(`stays quiet while the same workspace keeps reconnecting`, () => {
        workspaceReplaced(`sbx-1`, `ws-a`);
        expect(workspaceReplaced(`sbx-1`, `ws-a`)).toBe(false);
    });

    it(`reports a wiped-and-recreated workspace exactly once`, () => {
        workspaceReplaced(`sbx-1`, `ws-a`);
        expect(workspaceReplaced(`sbx-1`, `ws-b`)).toBe(true);
        expect(workspaceReplaced(`sbx-1`, `ws-b`)).toBe(false);
    });

    it(`tracks each sandbox's workspace independently`, () => {
        workspaceReplaced(`sbx-1`, `ws-a`);
        expect(workspaceReplaced(`sbx-2`, `ws-b`)).toBe(false);
    });
});

describe(`daemonRebuilt`, () => {
    beforeEach(() => localStorage.clear());

    it(`accepts a first sighting without claiming a rebuild`, () => {
        expect(daemonRebuilt(`sbx-1`, `0.0.0:1000`)).toBe(false);
    });

    it(`stays quiet across restarts of the same build`, () => {
        // The common case by far: a daemon restart is not a reason to throw away a working cache.
        daemonRebuilt(`sbx-1`, `0.0.0:1000`);
        expect(daemonRebuilt(`sbx-1`, `0.0.0:1000`)).toBe(false);
    });

    it(`reports a rebuilt daemon exactly once`, () => {
        daemonRebuilt(`sbx-1`, `0.0.0:1000`);
        expect(daemonRebuilt(`sbx-1`, `0.0.0:2000`)).toBe(true);
        expect(daemonRebuilt(`sbx-1`, `0.0.0:2000`)).toBe(false);
    });

    it(`tracks each sandbox's build independently`, () => {
        daemonRebuilt(`sbx-1`, `0.0.0:1000`);
        expect(daemonRebuilt(`sbx-2`, `0.0.0:2000`)).toBe(false);
    });

    it(`a daemon that advertises no build neither reports nor forgets`, () => {
        // Too old to interrogate — the silence must not read as a change, and must not overwrite what a newer
        // daemon on the same sandbox already told us.
        daemonRebuilt(`sbx-1`, `0.0.0:1000`);
        expect(daemonRebuilt(`sbx-1`, undefined)).toBe(false);
        expect(daemonRebuilt(`sbx-1`, `0.0.0:2000`)).toBe(true);
    });

    it(`is independent of the workspace identity on the same sandbox`, () => {
        // Two guards, two records: a rebuild must not read as a wipe, or a wipe as a rebuild.
        workspaceReplaced(`sbx-1`, `ws-a`);
        expect(daemonRebuilt(`sbx-1`, `ws-a`)).toBe(false);
    });
});

describe(`sandboxQueryPredicate`, () => {
    it(`matches only keys ending in that sandbox's id`, () => {
        const matches = sandboxQueryPredicate(`sbx-1`);
        expect(matches({ queryKey: [`workspace`, `tree`, `all`, `sbx-1`] })).toBe(true);
        expect(matches({ queryKey: [`workspace`, `tree`, `all`, `sbx-2`] })).toBe(false);
        // The id is APPENDED by sandboxKey, so an id appearing anywhere else is a different query's data.
        expect(matches({ queryKey: [`sbx-1`, `something`] })).toBe(false);
    });
});
