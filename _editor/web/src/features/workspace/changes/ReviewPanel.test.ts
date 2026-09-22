// jsdom because the subject is which sentence the column prints. The panel used to decide that from "a read is in
// flight", and a workspace being written to (a test run, a build) makes the daemon re-read this list about once a
// second — so a clean tree blinked between its answer and its waiting line for as long as the writes lasted. Only a
// render can tell those two sentences apart.
import "@intentic/testing/dom";
import type { GitChangesResponse } from "@intentic/api-contract";
import type { AgentSummary } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { VueQueryPlugin } from "@tanstack/vue-query";
import { it, expect, afterEach, mock } from "bun:test";
import { type App, createApp, h, nextTick } from "vue";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import { signalConnection } from "../../sandbox/client/useSandbox";
import { registry } from "../../agents/fleet/useAgents-registry";
import { changesKey } from "./useChanges";
import * as actualSandboxClient from "../../sandbox/client/sandboxClient";

// Every daemon read in the panel's graph goes through this one function. `/git/changes` is handed out a request at a
// time, so a read can be held open while the assertions run; everything else answers empty, since no other query
// decides anything here.
const held: ((response: GitChangesResponse) => void)[] = [];
mock.module("../../sandbox/client/sandboxClient", () => ({
    ...actualSandboxClient,
    sandboxJson: (path: string) => (path === `/git/changes` ? new Promise((resolve) => held.push(resolve)) : Promise.resolve({})),
}));

const { default: ReviewPanel } = await import("./ReviewPanel.vue");

let app: App | undefined;

const mount = async (): Promise<HTMLElement> => {
    // Reads are gated on a live daemon, and the read is the whole subject here, so the connection is stood up for
    // real rather than seeding an answer behind the panel's back.
    signalConnection({ kind: `switched`, lastKnownOnline: true });
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ setup: () => () => h(ReviewPanel) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    await nextTick();
    return el;
};

// Lets the query layer's own promise chain run out before the DOM is read.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

// Settles the oldest held read, then lets the render catch up.
const answer = async (response: GitChangesResponse): Promise<void> => {
    held.shift()?.(response);
    await settle();
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    queryClient.clear();
    held.length = 0;
    registry.value = [];
});

// One roster entry, cut to what the landing line reads: a conversation's status and what to call it.
const landing = (title: string): AgentSummary => ({
    id: `a1`,
    status: `landing`,
    title,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
});

it(`waits only for the first answer, then keeps it while the daemon is asked again`, async () => {
    const el = await mount();
    expect(el.textContent).toContain(`Loading changes…`);

    await answer({ repos: [] });
    expect(el.textContent).toContain(`No uncommitted changes.`);
    expect(el.textContent).not.toContain(`Loading changes…`);

    // Exactly what the file watcher does while a build or a test run writes into the workspace (systemEvents).
    void queryClient.invalidateQueries({ queryKey: changesKey() });
    await settle();

    // A read really is in flight — the point is that the answer on screen survives it.
    expect(held).toHaveLength(1);
    expect(el.textContent).toContain(`No uncommitted changes.`);
    expect(el.textContent).not.toContain(`Loading changes…`);

    await answer({ repos: [] });
    expect(el.textContent).toContain(`No uncommitted changes.`);
});

// The complaint this answers: press Land on the board, switch here, and read a flat denial that anything is happening
// for as long as the patch takes. The list is deliberately the tree from before the land — the review doesn't rescan
// mid-land — so the one thing it may not do is keep claiming the tree is clean.
it(`says what is being carried in instead of denying there is anything`, async () => {
    const el = await mount();
    await answer({ repos: [] });
    expect(el.textContent).toContain(`No uncommitted changes.`);

    registry.value = [landing(`Rewrite the parser`)];
    await nextTick();
    expect(el.textContent).toContain(`Landing Rewrite the parser…`);
    expect(el.textContent).not.toContain(`No uncommitted changes.`);

    // And gets out of the way the moment the tree can speak for itself.
    registry.value = [];
    await nextTick();
    expect(el.textContent).not.toContain(`Landing Rewrite the parser…`);
    expect(el.textContent).toContain(`No uncommitted changes.`);
});

// The expensive half of the same thing. Opening this panel is itself a read (nothing is ever fresh here), so pressing
// Land and switching straight to the workspace used to scan every repo against a tree the patch was still being
// written into — an answer thrown away, taking the git subprocesses the land was queued on with it.
it(`asks the daemon nothing while a land is applying, and asks once it settles`, async () => {
    registry.value = [landing(`Rewrite the parser`)];
    const el = await mount();
    await settle();

    expect(held).toHaveLength(0);
    expect(el.textContent).toContain(`Landing Rewrite the parser…`);

    registry.value = [];
    await settle();
    expect(held).toHaveLength(1);
});
