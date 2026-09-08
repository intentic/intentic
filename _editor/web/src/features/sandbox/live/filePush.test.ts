// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Needs jsdom: the stream router's import chain reaches the app's environment read at module eval.

vi.mock("../../../router", () => ({ router: { push: vi.fn() } }));
vi.mock("../../../app/analytics", () => ({ track: vi.fn() }));
vi.mock("../client/useSandbox", async () => {
    const { ref } = await import("vue");
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
vi.mock("../client/sandboxClient", () => ({ sandboxJson: vi.fn(), sandboxRequest: vi.fn() }));

import { STATE_DIR } from "@intentic/constants";
import { registerFileBindings } from "../../../extension-host/fileBindings";
import { onFilesChanged } from "../../../extension-host/fileEvents";
import { queryClient } from "../../../lib/queryPersistence";
import { applySystemEvent } from "./systemEvents";

// A file push evicts the query keys a `contributes.files` declaration names, and also announces the frame to
// listeners with no mounted query; an empty path list (too many to enumerate) means everything moved, not nothing.

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

// The daemon sends no path list past its per-frame cap, so a branch switch or mass delete arrives empty.
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
