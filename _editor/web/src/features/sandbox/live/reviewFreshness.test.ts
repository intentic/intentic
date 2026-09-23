import "@intentic/testing/dom";
import { ref } from "vue";

// Needs jsdom: the stream router's import chain reaches the app's environment read at module eval.

jest.mock("../../../router", () => ({ router: { push: jest.fn() } }));
jest.mock("../../../app/analytics", () => ({ track: jest.fn() }));
jest.mock("../client/useSandbox", () => {
    return {
        useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
        sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`],
    };
});
// Every name the app's graph imports from the daemon client, since bun links an ESM import against exactly what
// this factory returns; only the two below are ever called here.
jest.mock("../client/sandboxClient", () => ({
    sandboxJson: jest.fn(),
    sandboxRequest: jest.fn(),
    sandboxBlob: jest.fn(),
    sandboxUpload: jest.fn(),
    sandboxError: jest.fn(async () => new Error(`unused`)),
}));
// The two fields this import chain reads, both only as `.value`: `streaming` here, `conversations` in useChanges' own
// module-scope watch. Hoisted so a case can flip `streaming` before the frame is routed.
const streaming = { value: false };
const conversations = { value: [] as { streaming: { value: boolean } }[] };
jest.mock("../../chat/run/useChat", () => ({ useChat: () => ({ streaming, conversations }) }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { rpcKey, rpcKeyAt } from "../../../lib/queryKeys";
import { queryClient, UNPERSISTED } from "../../../lib/queryPersistence";
import { registry } from "../../agents/fleet/useAgents-registry";
import { applySystemEvent, CHANGES_REFRESH_MS } from "./systemEvents";

// One roster entry mid-land; nothing below reads past its status.
const LANDING: AgentSummary = {
    id: `a1`,
    status: `landing`,
    title: `Rewrite the parser`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
};

// An agent's review measures its branch against this workspace's tree and history, neither of which moves with a sha. A
// commit is `refsChanged`, a discard is `workspaceChanged`; this wires that signal to the agents' reviews.

const SANDBOX = `sbx-1`;

// A key, or the predicate deciding one; narrowed to the one field vue-query's Query actually needs here.
type Match = { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean };
let filters: Match[];

beforeEach(() => {
    filters = [];
    // Fake, because the rescan is throttled at module scope: one test's window would otherwise swallow the next one's
    // leading call.
    jest.useFakeTimers();
    jest.spyOn(queryClient, `invalidateQueries`).mockImplementation(async (given) => {
        filters.push(((typeof given === `function` ? given() : given) ?? {}) as Match);
    });
});

afterEach(() => {
    // Drains the trailing run so the throttle's window is closed again, not merely abandoned mid-flight.
    jest.advanceTimersByTime(5_000);
    jest.useRealTimers();
    registry.value = [];
    streaming.value = false;
});

// Whether anything in the batch would drop this key, by whichever means it was filed under.
const reaches = (key: readonly unknown[]): boolean =>
    filters.some(
        (filter) =>
            filter.predicate?.({ queryKey: key }) === true ||
            (filter.queryKey !== undefined && filter.queryKey.every((part, index) => key[index] === part)),
    );

it(`refreshes every open agent review when a commit moves the refs`, () => {
    applySystemEvent({ kind: `refsChanged`, repos: [`root`] }, SANDBOX);

    // Accepting a landing changes every review's answer about those files, in this box and any cached other.
    expect(reaches(rpcKey(`agents.diff`, { id: `a1` }))).toBe(true);
    expect(reaches(rpcKeyAt(`sbx-laptop`, `agents.diff`, { id: `a2` }))).toBe(true);
    // The rows a review opens go with it rather than outliving their own list.
    expect(reaches(rpcKey(`agents.fileDiff`, { id: `a1`, repo: `root`, path: `src/app.ts` }, UNPERSISTED))).toBe(true);
    // Where its landed work went is part of the same review, and goes stale with it.
    expect(reaches(rpcKey(`agents.history`, { id: `a1` }))).toBe(true);
    // The workspace's own review still refreshes, which is what this signal always did.
    expect(reaches(rpcKey(`git.changes`))).toBe(true);
    // Transcripts don't refresh: a commit says nothing about what anyone said, and rereading one is expensive.
    expect(reaches(rpcKey(`agents.transcript`, { id: `a1` }, UNPERSISTED))).toBe(false);
});

// A turn's writes are named, and scanning per name would spend a `git status` per repo on each one — but an unnamed
// batch is the daemon saying it cannot name what moved. The post-land check's build rewrites tracked files under
// `dist/`, which the watcher prunes, so this frame is the only word a browser gets that they came back; dropping it
// leaves whatever was read mid-build standing as the review's answer until something remounts the panel.
it(`re-reads the review on an unnamed batch mid-turn, and still not on a named one`, () => {
    streaming.value = true;

    applySystemEvent({ kind: `workspaceChanged`, paths: [`app/src/main.ts`] }, SANDBOX);
    expect(reaches(rpcKey(`git.changes`))).toBe(false);

    applySystemEvent({ kind: `workspaceChanged`, paths: [] }, SANDBOX);
    expect(reaches(rpcKey(`git.changes`))).toBe(true);
});

// A land writes the tree file by file and moves refs as it goes, so it fires this signal repeatedly against a patch
// that is only half applied. Each pass is a full `git status` + per-row diff over every repo, competing for the very
// git subprocesses the land is queued on — the scan is thrown away, and it makes the land it interrupted slower.
it(`leaves the review alone while a land is applying`, () => {
    registry.value = [LANDING];

    applySystemEvent({ kind: `refsChanged`, repos: [`root`] }, SANDBOX);
    expect(reaches(rpcKey(`git.changes`))).toBe(false);
    expect(reaches(rpcKey(`agents.diff`, { id: `a1` }))).toBe(false);

    // Bounded by the land itself: the throttle's own trailing run reads the tree once the lease has cleared, and
    // useChanges refetches on the same transition for a browser sitting on a quiet workspace.
    applySystemEvent({ kind: `refsChanged`, repos: [`root`] }, SANDBOX);
    registry.value = [];
    jest.advanceTimersByTime(CHANGES_REFRESH_MS);
    expect(reaches(rpcKey(`git.changes`))).toBe(true);
});
