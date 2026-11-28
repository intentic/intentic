import type { ExtensionCaller } from "@intentic/extension-api";
import type { z } from "zod";
import type { AddSourceSchema, CurateSchema, DiscoverHitView, Item, PeerView, Search, Settings, Snapshot, Source } from "../wire.js";
import type { Poller } from "./poller.js";
import type { DraftInput, Publisher } from "./publisher.js";
import { sourceInput } from "./poller.js";
import type { NetworkStore } from "./store.js";

/* WHAT THE VIEW, THE TOOLS AND THE POLL HANDLER SHARE: the store, the poller and the settings, behind one object a test
   stands up with a fake transport. Curator runs go through `startCurator`, handed in, so no test starts an agent. */

const FEED_LIMIT = 100;

// The followed sandboxes, as the Peers and Discover tabs reach them (server.ts builds it on peers/).
export interface PeerAccess {
    readonly views: (settings: Settings) => PeerView[];
    readonly release: (sourceId: string) => void;
    readonly discover: (settings: Settings, query: { readonly type?: string | undefined; readonly keyword?: string | undefined }, signal: AbortSignal) => Promise<DiscoverHitView[]>;
}

export interface NetworkServiceDeps {
    readonly store: NetworkStore;
    readonly poller: Poller;
    readonly publisher: Publisher;
    readonly peers: PeerAccess;
    readonly settings: () => Promise<Settings>;
    readonly startCurator: (settings: Settings, caller?: ExtensionCaller) => Promise<string>;
    readonly now: () => number;
    readonly log: (message: string) => void;
}

export const createService = (deps: NetworkServiceDeps) => {
    const { store, poller } = deps;
    let curating: { readonly conversationId: string; readonly at: number } | undefined;
    const service = {
        snapshot: async (canWrite = true): Promise<Snapshot> => {
            const settings = await deps.settings();
            return {
                sources: store.sources(),
                items: store.search({ limit: FEED_LIMIT }, true),
                settings,
                canWrite,
                uncurated: store.uncuratedCount(),
                publishing: await deps.publisher.overview(),
                peers: deps.peers.views(settings),
            };
        },
        // A held peer a person looked at and lets run again; its evidence stays on record.
        releasePeer: (sourceId: string): void => deps.peers.release(sourceId),
        discover: async (query: { readonly type?: string | undefined; readonly keyword?: string | undefined }, signal: AbortSignal) => deps.peers.discover(await deps.settings(), query, signal),
        search: (search: Partial<Search>): Item[] => store.search(search),
        feed: (limit: number): Item[] => store.search({ limit }, true),
        item: (id: string): Item | undefined => store.item(id),
        addSource: async (input: z.input<typeof AddSourceSchema>): Promise<Source> => {
            const source = store.add(sourceInput(input), deps.now());
            // Read at once so the person (or agent) who added it sees whether it works.
            await poller.refresh(true, source.id).catch((error: Error) => deps.log(`first read of ${source.id} failed: ${error.message}`));
            return store.source(source.id) ?? source;
        },
        removeSource: (id: string): void => store.remove(id),
        // A publication or a withdrawal, filed in the approvals queue: nothing is published until a person approves it.
        draftPublish: (input: DraftInput) => deps.publisher.draftPublish(input),
        draftWithdraw: (seq: number) => deps.publisher.draftWithdraw(seq),
        enableSource: (id: string, enabled: boolean): void => store.enable(id, enabled),
        curate: (entries: readonly z.infer<typeof CurateSchema>[]): void => store.curate(entries, deps.now()),
        refresh: (source?: string, signal?: AbortSignal): Promise<void> => poller.refresh(true, source, signal),
        // The scheduled poll: due sources only, then a curator run when the owner asked for one after new items.
        poll: async (signal: AbortSignal): Promise<void> => {
            const before = store.uncuratedCount();
            await poller.refresh(false, undefined, signal);
            const settings = await deps.settings();
            if (settings.autoCurate && store.uncuratedCount() > before) {
                await service.curateNow(undefined).catch((error: Error) => deps.log(`curator run did not start: ${error.message}`));
            }
        },
        // One curator run at a time from this backend: a second press within ten minutes answers the first run.
        curateNow: async (caller: ExtensionCaller | undefined): Promise<string> => {
            if (curating !== undefined && deps.now() - curating.at < 10 * 60_000) {
                return curating.conversationId;
            }
            const conversationId = await deps.startCurator(await deps.settings(), caller);
            curating = { conversationId, at: deps.now() };
            return conversationId;
        },
    };
    return service;
};

export type NetworkService = ReturnType<typeof createService>;
