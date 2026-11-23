import type { RunnerFeedCard, RunnerFeedFrame } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { BrowserSession, DesktopState, OpenBrowserResult } from "@intentic/sandbox-contract/schemas/terminal";
import type { RuntimeDomain } from "@intentic/sandbox-contract/state/runtime-state";
import type { runnerContract } from "@intentic/sandbox-contract/contracts/runner.contract";
import type { InferContractRouterInputs, InferContractRouterOutputs } from "@orpc/contract";

export type RunnerBrowserTab = InferContractRouterInputs<typeof runnerContract>["browserTab"];
// What a tab act answers: the window and the tab acted on or opened, nothing for a move.
export type RunnerTabAnswer = InferContractRouterOutputs<typeof runnerContract>["browserTab"];

/* THE RUNNER'S HALF OF ITS CONVERSATIONS' LIVE VIEWS (2026-11-23): the doors runnerContract's tail names, over what this
   daemon already keeps. A runner conversation's jobs and watches are held by this daemon's actors, its browsers and its
   desktop are this machine's, so the parent asks here and shows them as its own (runner-feed.ts on the parent). Each door
   answers what a local route would, by the same functions, and the parent decides who may ask: a runner runs without auth,
   and its only caller is the parent over the socket the runner dialled. */

// What the doors read of the daemon, narrowed so a test builds them without one.
export interface RunnerLiveDeps {
    // The live roster: one whole send on subscribe, then every change (conversations/registry/projection/roster-sends.ts).
    readonly subscribeRoster: (listener: (agents: AgentSummary[], rev: number, whole: boolean) => void) => () => void;
    // The runtime feed's change announcements (seams/runtime-feed.ts onRuntimeChange).
    readonly onRuntimeChange: (listener: (domains: RuntimeDomain[]) => void) => () => void;
    readonly browsers: () => BrowserSession[];
    readonly openBrowser: (url: string | undefined) => Promise<OpenBrowserResult>;
    readonly closeBrowser: (name: string) => Promise<void>;
    readonly closeBrowserPage: (name: string, pageId: string) => Promise<void>;
    readonly desktop: () => Promise<DesktopState>;
    // A tab's own menu or the strip's drag on one of this machine's windows (browser/tabs/browser-tabs.ts).
    readonly browserTab: (input: RunnerBrowserTab) => Promise<RunnerTabAnswer>;
    readonly stopJob: (conversationId: string, jobId: string) => Promise<boolean>;
    readonly stopWatches: (conversationId: string, watchId: string | undefined) => Promise<boolean>;
    // The reason this port may not be previewed, or undefined (ports/port-vet.ts).
    readonly vetPort: (port: number) => Promise<string | undefined>;
    // Ends the picture sockets and tokens held for a member, or for everyone.
    readonly revoke: (member: string | undefined) => Promise<void>;
}

const cardOf = (agent: AgentSummary): RunnerFeedCard => ({ conversationId: agent.id, jobs: agent.jobs ?? [], watches: agent.watches ?? [] });

// The frames the parent reads, as a queue the subscriptions push onto and the stream drains; ends with the signal.
export async function* runnerFeed(
    deps: Pick<RunnerLiveDeps, "subscribeRoster" | "onRuntimeChange">,
    signal?: AbortSignal,
): AsyncGenerator<RunnerFeedFrame> {
    const queued: RunnerFeedFrame[] = [];
    let wake: (() => void) | undefined;
    const push = (frame: RunnerFeedFrame): void => {
        queued.push(frame);
        wake?.();
    };
    // What the parent was last told of each conversation, as JSON, so a roster send that moved nothing of it says nothing.
    const told = new Map<string, string>();
    let first = true;
    const unroster = deps.subscribeRoster((agents, _rev, whole) => {
        const cards = agents.map(cardOf);
        if (first) {
            first = false;
            const held = cards.filter((card) => card.jobs.length > 0 || card.watches.length > 0);
            for (const card of held) {
                told.set(card.conversationId, JSON.stringify(card));
            }
            push({ kind: "cards", cards: held });
            return;
        }
        const seen = new Set<string>();
        for (const card of cards) {
            seen.add(card.conversationId);
            const said = JSON.stringify(card);
            if (said !== (told.get(card.conversationId) ?? JSON.stringify({ ...card, jobs: [], watches: [] }))) {
                told.set(card.conversationId, said);
                push({ kind: "card", card });
            }
        }
        // A conversation gone from a whole roster (archived, removed) holds nothing the parent should still show.
        for (const id of whole ? [...told.keys()].filter((known) => !seen.has(known)) : []) {
            told.delete(id);
            push({ kind: "card", card: { conversationId: id, jobs: [], watches: [] } });
        }
    });
    const unruntime = deps.onRuntimeChange((domains) => {
        for (const domain of domains) {
            if (domain === "browsers" || domain === "desktop") {
                push({ kind: "changed", domain });
            }
        }
    });
    let ended = signal?.aborted === true;
    const stopped = new Promise<void>((resolve) =>
        signal?.addEventListener(
            "abort",
            () => {
                ended = true;
                resolve();
            },
            { once: true },
        ),
    );
    try {
        for (;;) {
            if (ended) {
                return;
            }
            const next = queued.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            await Promise.race([new Promise<void>((resolve) => (wake = resolve)), stopped]);
            wake = undefined;
        }
    } finally {
        unroster();
        unruntime();
    }
}
