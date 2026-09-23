import "@intentic/testing/dom";
import { ref } from "vue";
import { it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";

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

import { STATE_DIR } from "@intentic/constants";
import { registerFileBindings } from "../../../extension-host/fileBindings";
import { onFilesChanged } from "../../../extension-host/fileEvents";
import { queryClient } from "../../../lib/queryPersistence";
import { viewsOnScreen } from "../../../testing/viewsOnScreen";
import { applySystemEvent } from "./systemEvents";

// A file push evicts the query keys a `contributes.files` declaration names, and also announces the frame to
// listeners with no mounted query; an empty path list (too many to enumerate) means everything moved, not nothing.

const SANDBOX = `sbx-1`;
const APPROVALS = `${STATE_DIR}/config/approvals/`;

let invalidated: unknown[][];
let invalidateSpy: ReturnType<typeof spyOn>;
let disposables: { dispose: () => void }[];

beforeEach(() => {
    invalidated = [];
    disposables = [];
    invalidateSpy = spyOn(queryClient, `invalidateQueries`).mockImplementation(async (filters) => {
        const resolved = typeof filters === `function` ? filters() : filters;
        invalidated.push([...(resolved?.queryKey ?? [])]);
    });
    disposables.push(registerFileBindings(`intentic.approvals`, [{ path: APPROVALS, invalidates: [`approvals`] }]));
});

afterEach(() => {
    for (const disposable of disposables.splice(0)) {
        disposable.dispose();
    }
});

const woken = (paths: readonly string[]): ReturnType<typeof mock> => {
    const listener = mock();
    disposables.push(onFilesChanged(paths, listener));
    return listener;
};

it(`announces a write to the extension that declared the path, as well as evicting its query`, () => {
    const listener = woken([APPROVALS]);

    applySystemEvent({ kind: `workspaceChanged`, paths: [`${APPROVALS}proposal.json`] }, SANDBOX);

    expect(invalidated).toContainEqual([`approvals`]);
    expect(listener).toHaveBeenCalledWith([`${APPROVALS}proposal.json`]);
});

// The daemon sends no path list past its per-frame cap, so a branch switch or mass delete arrives empty.
it(`treats a batch too large to list as "assume everything file-backed moved"`, () => {
    const listener = woken([APPROVALS]);

    applySystemEvent({ kind: `workspaceChanged`, paths: [] }, SANDBOX);

    expect(invalidated).toContainEqual([`approvals`]);
    expect(listener).toHaveBeenCalledWith([APPROVALS]);
});

// Through the real cache, since the count is the point: a view read twice on one reconnect costs the daemon twice.
it(`wakes the file-backed background state on a new connection, not just the mounted views`, async () => {
    invalidateSpy.mockRestore();
    // A write that landed while the stream was down was pushed once, to nobody, and no later frame repeats it.
    const listener = woken([APPROVALS]);
    const views = viewsOnScreen(queryClient, [[`approvals`, SANDBOX]]);
    try {
        applySystemEvent({ kind: `hello`, workspaceId: `ws-a`, routes: [], build: `0.0.0:1`, boot: undefined }, SANDBOX);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(views.reads([`approvals`, SANDBOX])).toBe(1);
        expect(listener).toHaveBeenCalledWith([APPROVALS]);
    } finally {
        views.unmount();
    }
});

// The daemon's table names a cache entry; the app files its own read of that route under the route's name, which the same
// push has to reach, and nothing else in that group.
it(`reaches the app's own read of the route a pushed name stands for`, () => {
    applySystemEvent({ kind: `workspaceChanged`, paths: [`${STATE_DIR}/config/settings.json`] }, SANDBOX);

    expect(invalidated).toContainEqual([`settings`]);
    expect(invalidated).toContainEqual([`settings.get`]);
    expect(invalidated).toContainEqual([`system.manifestProblems`]);
    expect(invalidated).not.toContainEqual([`settings.savings`]);
});

it(`leaves an extension that claimed a different path alone`, () => {
    const listener = woken([`${STATE_DIR}/records/chores/`]);

    applySystemEvent({ kind: `workspaceChanged`, paths: [`${APPROVALS}proposal.json`] }, SANDBOX);

    expect(listener).not.toHaveBeenCalled();
});
