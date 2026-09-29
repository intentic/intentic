import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { z } from "zod";
import { localFace } from "../../../app/environments/local";

// "Ask an agent about this" for a file on the user's own computer, the hosted workspace's half. The desktop app opens
// the workspace (never a local window) at `/?handoff=<base64url(JSON {url, token, name})>`: `url` is the file on the
// app's loopback file server (`http://127.0.0.1:<port>/workspace/raw?path=<file>`), and `token` a short-lived bearer
// for that one file. This module reads the link once, keeps it in this tab's session storage until a chat can take the
// file, and takes it out of the address; localHandoffArrival.ts brings the file into a new chat.

export const HANDOFF_QUERY = `handoff`;
export const HANDOFF_KEY = `intentic.localHandoff`;
// Past this a kept handoff is dropped unread: its token has long expired, and a file nobody has been waiting on for a
// quarter of an hour is not news.
export const HANDOFF_STALE_MS = 15 * 60_000;

// Where the app hands a file from: its own loopback file server's raw route, over plain http, with no credentials in the
// address. 127.0.0.1 only, as the app writes it: it is also the one loopback name the page's CSP lets it reach
// (nginx.conf `connect-src`), and nothing but that one route is a file this link may bring.
const onLoopback = (url: string): boolean => {
    const parsed = URL.parse(url);
    return (
        parsed !== null &&
        parsed.protocol === `http:` &&
        parsed.hostname === `127.0.0.1` &&
        parsed.pathname === `/workspace/raw` &&
        parsed.username === `` &&
        parsed.password === ``
    );
};

// A name the file can be attached under as it is: one path segment, with nothing unprintable in it.
const plainName = (name: string): boolean => name !== `.` && name !== `..` && !/[/\\\p{Cc}]/u.test(name);

const HandoffSchema = z.object({
    url: z.string().refine(onLoopback),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
    name: z.string().min(1).max(255).refine(plainName),
});
export type LocalHandoff = z.infer<typeof HandoffSchema>;

// As kept: the handoff and when it arrived, which staleness is measured from.
const KeptSchema = HandoffSchema.extend({ at: z.number() });

// base64url (RFC 4648 §5, padded or not) as UTF-8 text; undefined for anything that isn't.
const fromBase64Url = (value: string): string | undefined => {
    if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) {
        return undefined;
    }
    const base64 = value.replaceAll(`-`, `+`).replaceAll(`_`, `/`);
    try {
        const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, `=`));
        return new TextDecoder(`utf-8`, { fatal: true }).decode(Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0));
    } catch {
        // allow(silent-catch): bytes that aren't base64 or UTF-8 carry no handoff, which is the answer.
        return undefined;
    }
};

// JSON text as the value it spells, or undefined for text that isn't JSON.
const parsedJson = (text: string): ReturnType<typeof JSON.parse> => {
    try {
        return JSON.parse(text);
    } catch {
        // allow(silent-catch): text that isn't JSON carries no handoff, which is the answer.
        return undefined;
    }
};

/** The handoff a `?handoff=` value carries, or undefined for one that doesn't decode or doesn't validate. */
export const parseHandoff = (raw: string): LocalHandoff | undefined => {
    const text = fromBase64Url(raw);
    const parsed = text === undefined ? undefined : HandoffSchema.safeParse(parsedJson(text));
    return parsed?.success === true ? parsed.data : undefined;
};

// This tab's session storage, or undefined where the browser refuses it (storage blocked): nothing is kept then, and
// every navigation still goes through.
const tabStorage = (): Storage | undefined => {
    try {
        return sessionStorage;
    } catch {
        // allow(silent-catch): a browser that refuses storage refuses the handoff with it; the file stays where it is.
        return undefined;
    }
};

/** Keeps `handoff` for this tab until a chat can take it; `now` is when it arrived. */
export const keepHandoff = (handoff: LocalHandoff, now: number = Date.now()): void => {
    try {
        tabStorage()?.setItem(HANDOFF_KEY, JSON.stringify({ ...handoff, at: now }));
    } catch {
        // allow(silent-catch): a tab whose storage is full keeps nothing, as if nothing was handed.
    }
};

// The kept handoff while it is fresh; undefined for none, a stale one, or one that no longer reads.
const kept = (now: number): LocalHandoff | undefined => {
    const stored = KeptSchema.safeParse(parsedJson(tabStorage()?.getItem(HANDOFF_KEY) ?? ``));
    if (!stored.success || now - stored.data.at > HANDOFF_STALE_MS) {
        return undefined;
    }
    const { at: _arrived, ...handoff } = stored.data;
    return handoff;
};

/** Whether a fresh handoff is waiting in this tab, left where it is. */
export const handoffWaiting = (now: number = Date.now()): boolean => kept(now) !== undefined;

/** Takes the kept handoff out of this tab's storage: the fresh one, or undefined, a stale one being dropped unread. */
export const takeHandoff = (now: number = Date.now()): LocalHandoff | undefined => {
    const handoff = kept(now);
    tabStorage()?.removeItem(HANDOFF_KEY);
    return handoff;
};

// Started on the first handoff this page hears of, then told of each later one: the arrival is a chunk of its own,
// imported only by a page that has something to bring.
const arrive = (signedIn: () => boolean): void => {
    void import(`./localHandoffArrival`).then(({ startLocalHandoff }) => startLocalHandoff(signedIn));
};

// A handoff kept by this tab before a reload (the sign-in on the way here, say) is looked for once, on the first
// navigation.
let lookedForKept = false;

/**
 * The router's half, for every navigation: a `handoff` query is kept (when it validates) and the navigation replayed
 * without it, every other key riding along, so the bearer never sits in the address bar, the history or a sign-in's
 * return address. True for a navigation with nothing to take. Inert in a local window, which is never where the app
 * hands a file. `signedIn` says whether someone is, for the arrival to wait on.
 */
export const receiveHandoff = (to: Pick<RouteLocationNormalized, `path` | `query` | `hash`>, signedIn: () => boolean): true | RouteLocationRaw => {
    if (localFace() !== undefined) {
        return true;
    }
    const raw = to.query[HANDOFF_QUERY];
    const firstLook = !lookedForKept;
    lookedForKept = true;
    if (raw === undefined) {
        if (firstLook && handoffWaiting()) {
            arrive(signedIn);
        }
        return true;
    }
    const value = Array.isArray(raw) ? raw[0] : raw;
    const handoff = value === null || value === undefined ? undefined : parseHandoff(value);
    if (handoff !== undefined) {
        keepHandoff(handoff);
        arrive(signedIn);
    }
    const { [HANDOFF_QUERY]: _taken, ...query } = to.query;
    return { path: to.path, query, hash: to.hash, replace: true };
};
