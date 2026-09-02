// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The stream router's import chain reaches the app's environment read at module eval; jsdom plus these mocks are
// the whole of what it wants (the same edge runtimeEvents.test.ts cuts, for the same reason).

vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../analytics", () => ({ track: vi.fn() }));
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("./sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import { STATE_DIR } from "@intentic/constants";
import { registerFileBindings } from "../../extension-host/fileBindings";
import { onFilesChanged } from "../../extension-host/fileEvents";
import { queryClient } from "../queryPersistence";
import { applySystemEvent } from "./systemEvents";

/* WHAT A FILE PUSH REACHES, both halves of it.
 *
 * A `contributes.files` declaration had exactly one effect: evict the query keys it names. That serves whatever
 * the reader is LOOKING at and nothing else, because an eviction only reaches a query something observes, and the
 * badge on a rail tile is read with nothing mounted. So the extension's own background state, the thing that
 * decides what the tile says, was on a timer and every tile in the app was as fresh as its interval.
 *
 * These are the two properties that fix it: the same frame is announced, and the frame that means the MOST (no
 * path list at all) stops being the frame that means nothing. */

const SANDBOX = `sbx-1`;
const APPROVALS = `${STATE_DIR}/config/approvals/`;

let invalidated: unknown[][];
let disposables: { dispose: () => void }[];

beforeEach(() => {
    invalidated = [];
    disposables = [];
    vi.spyOn(queryClient, `invalidateQueries`).mockImplementation(async (filters) => {
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

const woken = (paths: readonly string[]): ReturnType<typeof vi.fn> => {
    const listener = vi.fn();
    disposables.push(onFilesChanged(paths, listener));
    return listener;
};

it(`announces a write to the extension that declared the path, as well as evicting its query`, () => {
    const listener = woken([APPROVALS]);

    applySystemEvent({ kind: `workspaceChanged`, paths: [`${APPROVALS}proposal.json`] }, SANDBOX);

    expect(invalidated).toContainEqual([`approvals`]);
    expect(listener).toHaveBeenCalledWith([`${APPROVALS}proposal.json`]);
});

/* The daemon sends no path list past its per-frame cap, so a branch switch, a codegen run or a mass delete
 * arrives as an empty batch. Matched against a prefix table that is nothing, which made the largest change in the
 * app the only one that refreshed neither a view nor a badge. */
it(`treats a batch too large to list as "assume everything file-backed moved"`, () => {
    const listener = woken([APPROVALS]);

    applySystemEvent({ kind: `workspaceChanged`, paths: [] }, SANDBOX);

    expect(invalidated).toContainEqual([`approvals`]);
    expect(listener).toHaveBeenCalledWith([APPROVALS]);
});

it(`wakes the file-backed background state on a new connection, not just the mounted views`, () => {
    // A write that landed while the stream was down was pushed once, to nobody, and no later frame repeats it.
    const listener = woken([APPROVALS]);

    applySystemEvent({ kind: `hello`, workspaceId: `ws-a`, routes: [], build: `0.0.0:1`, boot: undefined }, SANDBOX);

    expect(invalidated).toContainEqual([`approvals`]);
    expect(listener).toHaveBeenCalledWith([APPROVALS]);
});

it(`leaves an extension that claimed a different path alone`, () => {
    const listener = woken([`${STATE_DIR}/records/chores/`]);

    applySystemEvent({ kind: `workspaceChanged`, paths: [`${APPROVALS}proposal.json`] }, SANDBOX);

    expect(listener).not.toHaveBeenCalled();
});
