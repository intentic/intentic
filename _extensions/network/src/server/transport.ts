import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WebUrlSchema, type BridgeItem } from "./records.js";
import { NostrEventSchema, parseNostr } from "./bridges/nostr.js";

const BODY_LIMIT = 2 * 1024 * 1024;
export const TIMEOUT_MS = 15000;
export interface HttpRead { body: string; status: number; etag: string | null; lastModified: string | null }
export interface Validators { etag: string | null; lastModified: string | null }
export interface Transport {
    http(url: string, validators: Validators, signal: AbortSignal): Promise<HttpRead>;
    nostr(relay: string, author: string, signal: AbortSignal): Promise<BridgeItem[]>;
}
export const relayUrls = (value: string): string[] => {
    const urls = [...new Set(value.split(/[\s,]+/u).filter(Boolean))];
    if (!urls.length || urls.length > 8) {throw new Error("Set one to eight Nostr relays");}
    for (const address of urls) {
        const url = new URL(address);
        if (url.protocol !== "wss:" || url.username || url.password || url.hash) {throw new Error("Nostr relays must be wss:// URLs without credentials");}
    }
    return urls;
};
export const readBounded = async (response: Response, limit = BODY_LIMIT): Promise<string> => {
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Response exceeds size limit"); }
    const reader = response.body?.getReader();
    if (!reader) {return "";}
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {break;}
            size += value.byteLength;
            if (size > limit) {throw new Error("Response exceeds size limit");}
            chunks.push(value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return Buffer.concat(chunks).toString("utf8");
};
const requestHeaders = (validators: Validators): Headers => {
    const headers = new Headers({ accept: "application/feed+json, application/json, application/atom+xml, application/rss+xml, application/xml, text/xml", "user-agent": "intentic.network/1.0" });
    if (validators.etag) {headers.set("if-none-match", validators.etag);}
    if (validators.lastModified) {headers.set("if-modified-since", validators.lastModified);}
    return headers;
};

// Where a redirect points, checked like the first address; undefined when the answer is no redirect.
const redirectOf = async (response: Response, from: string): Promise<string | undefined> => {
    if (![301, 302, 303, 307, 308].includes(response.status)) {return undefined;}
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) {throw new Error("Redirect without Location");}
    return WebUrlSchema.parse(new URL(location, from).href);
};

const answerOf = async (response: Response): Promise<HttpRead> => {
    const metadata = { status: response.status, etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") };
    if (response.status === 304) { await response.body?.cancel(); return { ...metadata, body: "" }; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Source returned HTTP ${response.status}`); }
    return { ...metadata, body: await readBounded(response) };
};

export const createTransport = (fetcher: typeof fetch = fetch): Transport => {
    const nextHost = new Map<string, number>();
    const polite = async (address: string, signal: AbortSignal): Promise<void> => {
        const host = new URL(address).hostname;
        const now = Date.now();
        const next = Math.max(now, nextHost.get(host) ?? 0);
        nextHost.set(host, next + 1000);
        if (nextHost.size > 1024) {for (const [key, time] of nextHost) {if (time < now) {nextHost.delete(key);}}}
        if (next > now) {await delay(next - now, undefined, { signal });}
        signal.throwIfAborted();
    };
    return {
        async http(address, validators, parent) {
            const signal = AbortSignal.any([parent, AbortSignal.timeout(TIMEOUT_MS)]);
            let url = WebUrlSchema.parse(address);
            for (let redirects = 0; redirects <= 3; redirects++) {
                await polite(url, signal);
                const response = await fetcher(url, { headers: requestHeaders(validators), redirect: "manual", signal });
                const next = await redirectOf(response, url);
                if (next === undefined) {return answerOf(response);}
                url = next;
            }
            throw new Error("Too many redirects");
        },
        async nostr(relay, author, parent) {
            relayUrls(relay);
            const signal = AbortSignal.any([parent, AbortSignal.timeout(TIMEOUT_MS)]);
            await polite(relay, signal);
            return readRelay(relay, author, signal);
        },
    };
};

const FrameSchema = z.tuple([z.string()]).rest(z.json());
const RELAY_ITEMS_MAX = 100;
const RELAY_MESSAGES_MAX = 250;

// What one relay frame means for the read: an event to keep, the end of stored events, or nothing for this read.
type FrameMeaning = { readonly kind: "item"; readonly item: BridgeItem } | { readonly kind: "end" } | { readonly kind: "skip" };
const frameMeaning = (text: string, subscription: string, author: string, relay: string): FrameMeaning => {
    const frame = FrameSchema.parse(JSON.parse(text));
    if (frame[1] !== subscription) {return { kind: "skip" };}
    if (frame[0] === "EOSE") {return { kind: "end" };}
    if (frame[0] === "CLOSED") {throw new Error("Relay refused subscription");}
    if (frame[0] !== "EVENT") {return { kind: "skip" };}
    const result = NostrEventSchema.safeParse(frame[2]);
    return result.success && result.data.pubkey === author ? { kind: "item", item: parseNostr(result.data, relay) } : { kind: "skip" };
};

const readRelay = (relay: string, author: string, signal: AbortSignal): Promise<BridgeItem[]> => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const socket = new WebSocket(relay);
    const subscription = randomUUID();
    const items = new Map<string, BridgeItem>();
    let bytes = 0;
    let messages = 0;
    let ended = false;
    const finish = (error?: Error): void => {
        if (ended) {return;}
        ended = true;
        signal.removeEventListener("abort", abort);
        if (socket.readyState === WebSocket.OPEN) {socket.send(JSON.stringify(["CLOSE", subscription]));}
        socket.close();
        if (error) {reject(error);} else {resolve([...items.values()]);}
    };
    const abort = () => finish(new Error("Relay read timed out or stopped"));
    const take = (text: string): void => {
        bytes += Buffer.byteLength(text);
        if (++messages > RELAY_MESSAGES_MAX || bytes > BODY_LIMIT) {throw new Error("Relay exceeded response limit");}
        const meaning = frameMeaning(text, subscription, author, relay);
        if (meaning.kind === "end") { finish(); return; }
        if (meaning.kind === "item") { items.set(meaning.item.nativeId, meaning.item); }
        if (items.size >= RELAY_ITEMS_MAX) {finish();}
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => socket.send(JSON.stringify(["REQ", subscription, { authors: [author], kinds: [1, 30023], limit: RELAY_ITEMS_MAX }])));
    socket.addEventListener("error", () => finish(new Error("Relay connection failed")));
    socket.addEventListener("close", () => finish(new Error("Relay closed before EOSE")));
    socket.addEventListener("message", (message) => {
        try { take(z.string().parse(message.data)); }
        catch (error) { finish(error instanceof Error ? error : new Error("Invalid relay response")); }
    });
});
