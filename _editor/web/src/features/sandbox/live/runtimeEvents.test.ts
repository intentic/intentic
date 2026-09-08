// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

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

import { queryClient } from "../../../lib/queryPersistence";
import { applySystemEvent } from "./systemEvents";

// These views hold no timer of their own, so this frame is their entire live feed; right views refresh, wrong ones are
// left alone, and a reconnect re-asks everything.

const SANDBOX = `sbx-1`;

// Which query keys were asked to refresh, spied rather than driven through a real cache.
let invalidated: unknown[][];
beforeEach(() => {
    invalidated = [];
    vi.spyOn(queryClient, `invalidateQueries`).mockImplementation(async (filters) => {
        const resolved = typeof filters === `function` ? filters() : filters;
        invalidated.push([...(resolved?.queryKey ?? [])]);
    });
});

it(`refreshes the terminal surfaces when the daemon says a session moved`, () => {
    applySystemEvent({ kind: `runtimeChanged`, domains: [`terminals`] }, SANDBOX);
    expect(invalidated).toEqual([[`terminals`]]);
});

it(`refreshes the panels AND the per-repo apps from one dev-server frame`, () => {
    // Both lists are drawn from the same managed process, so one domain name invalidates both keys.
    applySystemEvent({ kind: `runtimeChanged`, domains: [`panels`] }, SANDBOX);
    expect(invalidated).toEqual([[`panels`], [`apps`]]);
});

it(`asks nothing of a domain this build does not know`, () => {
    // A daemon newer than the browser. Refreshing what we understand beats discarding the frame.
    applySystemEvent({ kind: `runtimeChanged`, domains: [`something-later`] }, SANDBOX);
    expect(invalidated).toEqual([]);
});

it(`leaves the file-backed views alone: a running thing moving is not a file changing`, () => {
    applySystemEvent({ kind: `runtimeChanged`, domains: [`browsers`, `subagents`] }, SANDBOX);
    expect(invalidated).toEqual([[`browsers`], [`subagents`]]);
});

it(`re-asks every runtime-bound view on a new connection`, () => {
    // Replaces the polls: a frame missed while the stream was down is never resent, so hello re-asks all.
    applySystemEvent({ kind: `hello`, workspaceId: `ws-a`, routes: [], build: `0.0.0:1`, boot: undefined }, SANDBOX);
    for (const key of [`terminals`, `panels`, `apps`, `ports`, `browsers`, `subagents`]) {
        expect(invalidated).toContainEqual([key]);
    }
});
