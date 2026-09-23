import "@intentic/testing/dom";
import { ref } from "vue";
import { it, expect, beforeEach, mock, spyOn } from "bun:test";

// Needs jsdom: the stream router's import chain reaches the app's environment read at module eval.

mock.module("../../../router", () => ({ router: { push: mock() } }));
mock.module("../../../app/analytics", () => ({ track: mock() }));
mock.module("../client/useSandbox", () => {
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
// Every name the app's graph imports from the daemon client, since bun links an ESM import against exactly what
// this factory returns; only the two below are ever called here.
mock.module("../client/sandboxClient", () => ({
    sandboxJson: mock(),
    sandboxRequest: mock(),
    sandboxBlob: mock(),
    sandboxUpload: mock(),
    sandboxError: mock(async () => new Error(`unused`)),
}));

import { queryClient } from "../../../lib/queryPersistence";
import { viewsOnScreen } from "../../../testing/viewsOnScreen";
import { onReposChanged } from "../../../extension-host/repoEvents";
import { applySystemEvent } from "./systemEvents";

// These views hold no timer of their own, so this frame is their entire live feed; right views refresh, wrong ones are
// left alone, and a reconnect re-asks everything.

const SANDBOX = `sbx-1`;

// Which query keys were asked to refresh, spied rather than driven through a real cache.
let invalidated: unknown[][];
let invalidateSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
    invalidated = [];
    invalidateSpy = spyOn(queryClient, `invalidateQueries`).mockImplementation(async (filters) => {
        const resolved = typeof filters === `function` ? filters() : filters;
        invalidated.push([...(resolved?.queryKey ?? [])]);
    });
});

// Each pushed name reaches what an extension files under it, then the app's own read of the route it stands for.
it(`refreshes the terminal surfaces when the daemon says a session moved`, () => {
    applySystemEvent({ kind: `runtimeChanged`, domains: [`terminals`] }, SANDBOX);
    expect(invalidated).toEqual([[`terminals`], [`system.terminals`]]);
});

it(`refreshes the panels AND the per-repo apps from one dev-server frame`, () => {
    // Both lists are drawn from the same managed process, so one domain name invalidates both keys.
    applySystemEvent({ kind: `runtimeChanged`, domains: [`panels`] }, SANDBOX);
    expect(invalidated).toEqual([[`panels`], [`panels.list`], [`apps`]]);
});

// The Projects dashboard lists every repo, not the open project's, so the narrowed panels list cannot tell it.
it(`hands a new repository set to extensions as well as refreshing the panels`, () => {
    const heard: (readonly string[])[] = [];
    const listening = onReposChanged((repos) => heard.push(repos));
    try {
        applySystemEvent({ kind: `reposChanged`, repos: [`root`, `web`, `cloned`] }, SANDBOX);
    } finally {
        listening.dispose();
    }
    expect(invalidated).toEqual([[`panels.list`]]);
    expect(heard).toEqual([[`root`, `web`, `cloned`]]);
});

it(`asks nothing of a domain this build does not know`, () => {
    // A daemon newer than the browser. Refreshing what we understand beats discarding the frame.
    applySystemEvent({ kind: `runtimeChanged`, domains: [`something-later`] }, SANDBOX);
    expect(invalidated).toEqual([]);
});

it(`leaves the file-backed views alone: a running thing moving is not a file changing`, () => {
    applySystemEvent({ kind: `runtimeChanged`, domains: [`browsers`, `subagents`] }, SANDBOX);
    expect(invalidated).toEqual([[`browsers`], [`system.browsers`], [`subagents`], [`system.subagents`]]);
});

// Driven through the real cache: what matters is how many reads reach the daemon, and a second invalidation of a key
// already refetching cancels that read and starts another, which the daemon answers both of.
it(`re-asks every runtime-bound view on a new connection, once each`, async () => {
    invalidateSpy.mockRestore();
    // Replaces the polls: a frame missed while the stream was down is never resent, so hello re-asks all.
    const keys = [
        `terminals`,
        `panels`,
        `apps`,
        `ports`,
        `browsers`,
        `subagents`,
        `capabilities`,
        `system.terminals`,
        `panels.list`,
        `ports.list`,
        `system.browsers`,
        `system.subagents`,
        `capabilities.list`,
        `system.devices`,
    ].map((key) => [key, SANDBOX]);
    const views = viewsOnScreen(queryClient, keys);
    try {
        applySystemEvent({ kind: `hello`, workspaceId: `ws-a`, routes: [], build: `0.0.0:1`, boot: undefined }, SANDBOX);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(keys.map((key) => [key[0], views.reads(key)])).toEqual(keys.map((key) => [key[0], 1]));
    } finally {
        views.unmount();
    }
});
