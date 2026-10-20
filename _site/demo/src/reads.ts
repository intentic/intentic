import { VITALS_PATH } from "@intentic/sandbox-contract/protocol/vitals";
import { type DemoHandler, json } from "./transport";

// HOW THE DAEMON'S READS ANSWER this page load, from `?reads=`, sticky per tab like the mode and the outage: the way to
// look at a region's wait and its failure (`<Await>` in @intentic/ui) on any route, which a fixture that answers at once
// never shows. `?reads=none` ends it. `?readsMatch=<text>` narrows it to reads whose path holds that text, so one region
// can be slowed or failed while the shell around it answers as ever.
//   slow      every read answers, SLOW_MS late: the remembered look or the fallback, then past five seconds the wait
//             says how long it has run
//   stalled   every read hangs until its caller gives up: a wait that never ends
//   failing   every read answers 500 with a sentence: the region's failure, in the daemon's own words
// A read is a GET on the daemon. The event stream, the vitals probe and the health check are never touched: they are
// how the app knows the sandbox is up at all, which is the outage's to act out (outage.ts), not this.

const READS = [`slow`, `stalled`, `failing`] as const;
type DemoReads = (typeof READS)[number];

const STORAGE_KEY = `intentic.demo.reads`;
const MATCH_KEY = `intentic.demo.readsMatch`;
const SLOW_MS = 7_000;

const sticky = <T extends string>(param: string, key: string, accept: (value: string) => T | undefined): T | undefined => {
    const url = new URL(window.location.href);
    const asked = url.searchParams.get(param);
    if (asked !== null) {
        url.searchParams.delete(param);
        window.history.replaceState(window.history.state, ``, url);
        if (asked === `none` || asked === ``) {
            window.sessionStorage.removeItem(key);
        }
    }
    const value = accept(asked ?? window.sessionStorage.getItem(key) ?? ``);
    if (value !== undefined) {
        window.sessionStorage.setItem(key, value);
    }
    return value;
};

/** How this page load's reads answer, resolved once before boot; undefined for reads that answer at once. */
const demoReads = sticky(`reads`, STORAGE_KEY, (value) => READS.find((candidate) => candidate === value));
const readsMatch = sticky(`readsMatch`, MATCH_KEY, (value) => (value === `` || value === `none` ? undefined : value));

const UNTOUCHED = [`/events`, `/health`, VITALS_PATH];

const touched = (request: Request, url: URL): boolean =>
    request.method === `GET` &&
    !UNTOUCHED.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`)) &&
    (readsMatch === undefined || url.pathname.includes(readsMatch));

// Given up the way the caller gives up: by its own signal.
const hang = (request: Request): Promise<Response> =>
    new Promise((_, reject) => {
        request.signal.addEventListener(`abort`, () => reject(new DOMException(`The operation was aborted.`, `AbortError`)), { once: true });
    });

const late = (request: Request, answer: () => Promise<Response>): Promise<Response> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(answer()), SLOW_MS);
        request.signal.addEventListener(
            `abort`,
            () => {
                clearTimeout(timer);
                reject(new DOMException(`The operation was aborted.`, `AbortError`));
            },
            { once: true },
        );
    });

/** The daemon's handler, with its reads answering as this page load asks. */
export const withReads =
    (daemon: DemoHandler, reads: DemoReads | undefined = demoReads): DemoHandler =>
    async (request, url) => {
        if (reads === undefined || !touched(request, url)) {
            return daemon(request, url);
        }
        switch (reads) {
            case `slow`:
                return late(request, () => daemon(request, url));
            case `stalled`:
                return hang(request);
            case `failing`:
                return json({ code: `INTERNAL_SERVER_ERROR`, status: 500, message: `The demo was asked to fail this read (${url.pathname}).` }, 500);
        }
    };

export const readsNote = (): string | undefined =>
    demoReads === undefined ? undefined : `[demo] daemon reads are ${demoReads}${readsMatch === undefined ? `` : ` where the path holds "${readsMatch}"`} (?reads=none ends it)`;
