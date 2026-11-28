import type { z } from "zod";
import { AddSourceSchema, SettingsSchema, type Settings, type Source } from "../wire.js";
import { WebUrlSchema, type BridgeItem } from "./records.js";
import { parseFeed } from "./bridges/rss.js";
import { parseBluesky } from "./bridges/bluesky.js";
import { nostrAuthor } from "./bridges/nostr.js";
import { parseAtlas } from "./bridges/atlas.js";
import type { NetworkStore } from "./store.js";
import { relayUrls, type Transport } from "./transport.js";
import { normalizeAddress } from "@intentic/sandbox-contract/s2s";
import type { PeerRead } from "../peers/sync.js";

// How a source of kind `intentic` (another sandbox's log) is read: peers/sync.ts, handed in so the poller needs no network of its own.
export type PeerReader = (source: Source, signal: AbortSignal) => Promise<PeerRead>;

export const sourceInput = (input: z.input<typeof AddSourceSchema>): z.infer<typeof AddSourceSchema> => {
    const source = AddSourceSchema.parse(input);
    if (source.kind === "nostr") {return { ...source, address: nostrAuthor(source.address) };}
    if (source.kind === "intentic") {
        const address = normalizeAddress(source.address);
        if (address === undefined) {throw new Error("Expected a sandbox's host or its own domain");}
        return { ...source, address };
    }
    if (source.kind === "bluesky") {
        const address = source.address.replace(/^@/u, "");
        if (!/^(?:[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+|did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)$/u.test(address)) {throw new Error("Expected a Bluesky handle or DID");}
        return { ...source, address };
    }
    return { ...source, address: WebUrlSchema.parse(source.address) };
};
export const settingsOf = (values: Readonly<Record<string, string | number | boolean>>): Settings => SettingsSchema.parse(values);
const backoffMs = (failures: number, minutes: number): number => Math.min(86400000, minutes * 60000 * 2 ** Math.min(failures, 10));

const httpAddress = (source: Source): string => {
    if (source.kind === "bluesky") {return `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(source.address)}&limit=100`;}
    if (source.kind === "atlas") {return `${source.address.replace(/\/$/u, "")}/envelopes/type/${encodeURIComponent(source.schemaType)}`;}
    return source.address;
};
const relayItems = async (transport: Transport, source: Source, settings: Settings, signal: AbortSignal): Promise<BridgeItem[]> => {
    const items = new Map<string, BridgeItem>();
    const errors: string[] = [];
    let successes = 0;
    for (const relay of relayUrls(settings.nostrRelays)) {
        try {
            for (const item of await transport.nostr(relay, nostrAuthor(source.address), signal)) {
                if (items.get(item.nativeId)?.verification !== "signature-valid") {items.set(item.nativeId, item);}
            }
            successes++;
        } catch (error) { errors.push(error instanceof Error ? error.message : "Relay failed"); }
    }
    if (!successes) {throw new Error(errors.join("; "));}
    return [...items.values()].slice(0, 100);
};

interface SourceRead { readonly items: BridgeItem[]; readonly withdrawn?: readonly string[]; readonly etag: string | null; readonly lastModified: string | null }

const parseBody = (source: Source, body: string): BridgeItem[] => {
    if (source.kind === "rss") {return parseFeed(body, source.address);}
    if (source.kind === "bluesky") {return parseBluesky(body, source.address);}
    return parseAtlas(body, source.address);
};

// One source read through its bridge; a 304 keeps the validators it had when the server sends none.
const readSource = async (transport: Transport, source: Source, settings: Settings, signal: AbortSignal, peerRead: PeerReader | undefined): Promise<SourceRead> => {
    if (source.kind === "intentic") {
        if (peerRead === undefined) {throw new Error("Following other sandboxes is not wired here");}
        return { ...(await peerRead(source, signal)), etag: null, lastModified: null };
    }
    if (source.kind === "nostr") {return { items: await relayItems(transport, source, settings, signal), etag: source.etag, lastModified: source.lastModified };}
    const response = await transport.http(httpAddress(source), source, signal);
    if (response.status === 304) {return { items: [], etag: response.etag ?? source.etag, lastModified: response.lastModified ?? source.lastModified };}
    return { items: parseBody(source, response.body), etag: response.etag, lastModified: response.lastModified };
};

export const createPoller = (store: NetworkStore, transport: Transport, getSettings: () => Promise<Settings>, now: () => number = Date.now, peerRead?: PeerReader) => {
    let running: Promise<void> | undefined;
    const controller = new AbortController();
    const pollOne = async (source: Source, settings: Settings, signal: AbortSignal): Promise<void> => {
        try {
            const read = await readSource(transport, source, settings, signal, peerRead);
            // A source removed or disabled while its request was in flight stays removed or disabled.
            if (!store.source(source.id)?.enabled) {return;}
            store.ingest(source.id, read.items, now());
            store.forget(source.id, read.withdrawn ?? []);
            store.polled(source.id, { lastPollAt: now(), nextPollAt: now() + settings.pollMinutes * 60000, failures: 0, lastError: null, etag: read.etag, lastModified: read.lastModified });
        } catch (error) {
            if (signal.aborted) {throw error;}
            const lastError = (error instanceof Error ? error.message : "Source read failed").slice(0, 2000);
            store.polled(source.id, { lastPollAt: now(), nextPollAt: now() + backoffMs(source.failures + 1, settings.pollMinutes), failures: source.failures + 1, lastError, etag: source.etag, lastModified: source.lastModified });
        }
    };
    const once = async (force: boolean, only?: string, parent?: AbortSignal): Promise<void> => {
        const settings = await getSettings();
        const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
        const isDue = (source: Source): boolean => source.enabled && (!only || source.id === only) && (force || source.nextPollAt <= now());
        const due = store.sources().filter(isDue).sort((a, b) => a.nextPollAt - b.nextPollAt).slice(0, 20);
        for (const source of due) {
            signal.throwIfAborted();
            await pollOne(source, settings, signal);
        }
        store.prune(now(), settings.retentionDays, settings.maxItems);
    };
    return {
        refresh(force = false, only?: string, signal?: AbortSignal): Promise<void> {
            if (running) {return running;}
            running = once(force, only, signal).finally(() => { running = undefined; });
            return running;
        },
        // allow(silent-catch): a read that ends in error while stopping is the stop itself; nothing is left to report
        async stop(): Promise<void> { controller.abort(); await running?.catch(() => {}); },
    };
};
export type Poller = ReturnType<typeof createPoller>;
