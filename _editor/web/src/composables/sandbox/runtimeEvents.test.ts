// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

// The stream router's import chain reaches the app's environment read at module eval; jsdom plus this is the
// whole of what it wants (the same edge daemonRestart.test.ts cuts, for the same reason).
vi.hoisted(() => {
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

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

import { queryClient } from "../queryPersistence";
import { applySystemEvent } from "./systemEvents";

/* WHAT THE RUNTIME PUSH ACTUALLY REFRESHES.
 *
 * These views hold no timer any more, so this frame is their entire live feed: whatever it fails to invalidate
 * simply stays wrong until the user navigates. The three properties below are what make dropping the polls safe
 * — the right views refresh, the wrong ones are left alone, and a reconnect re-asks the lot. */

const SANDBOX = `sbx-1`;

// Which query keys were asked to refresh, in the order they were asked. `invalidateQueries` is spied rather
// than driven through a real cache: the subject is the ROUTING, and a key with no observer invalidates just the
// same (which is the property that makes pushing a domain nobody is watching free).
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
    // Both lists are drawn from the same managed process, so the domain names both keys — an app preview left
    // reading "starting" after its server came up is the failure this covers.
    applySystemEvent({ kind: `runtimeChanged`, domains: [`panels`] }, SANDBOX);
    expect(invalidated).toEqual([[`panels`], [`apps`]]);
});

it(`asks nothing of a domain this build does not know`, () => {
    // A daemon newer than the browser. Refreshing what we understand beats discarding the frame.
    applySystemEvent({ kind: `runtimeChanged`, domains: [`something-later`] }, SANDBOX);
    expect(invalidated).toEqual([]);
});

it(`leaves the file-backed views alone — a running thing moving is not a file changing`, () => {
    applySystemEvent({ kind: `runtimeChanged`, domains: [`browsers`, `subagents`] }, SANDBOX);
    expect(invalidated).toEqual([[`browsers`], [`subagents`]]);
});

it(`re-asks every runtime-bound view on a new connection`, () => {
    /* The recovery that replaces the polls. A frame produced while the stream was down is a frame nobody will
     * resend, so a panel that finished starting or a session that exited while this browser was away would sit
     * wrong indefinitely — these views have no clock of their own to catch up on. */
    applySystemEvent({ kind: `hello`, workspaceId: `ws-a`, routes: [], build: `0.0.0:1`, boot: undefined }, SANDBOX);
    for (const key of [`terminals`, `panels`, `apps`, `ports`, `browsers`, `subagents`]) {
        expect(invalidated).toContainEqual([key]);
    }
});
