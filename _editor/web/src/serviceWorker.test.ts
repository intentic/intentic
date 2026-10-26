import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { withPrecache, type PrecacheManifest } from "../vite.offline";

// public/sw.js as the browser runs it: the real file, evaluated in a realm of its own with the worker's globals faked
// (Cache Storage, fetch, timers, its event target), driven by the events a browser would dispatch. What it answers,
// what it keeps, and what it never touches are asserted on what comes out, not on its internals.

const ORIGIN = `https://app.intentic.dev`;
const WORKER_SOURCE = readFileSync(resolve(import.meta.dirname, `../public/sw.js`), `utf8`);
const MANIFEST: PrecacheManifest = { build: `1793020000000`, urls: [`/`, `/assets/js/env.js`, `/assets/index-a1.css`, `/assets/index-b2.js`, `/assets/Shell-c3.js`] };
const PATIENCE_MS = 15000;

// A request as the worker reads one: a constructed Request cannot be a navigation, so the fake carries its own mode.
class FakeRequest {
    constructor(
        readonly url: string,
        readonly method: string,
        readonly mode: string,
        readonly headers: Headers,
    ) {}
}

// An answer the test hands over later than the worker asked for it.
class Later {
    constructor(readonly response: Promise<Response>) {}
}

type Answer = Response | Error | Later;

// A response of this origin, as a worker sees one from its own fetch: `basic`, which a constructed Response is not.
const ours = (body: string, init: ResponseInit & { redirected?: boolean } = {}): Response => {
    const response = new Response(body, init);
    Object.defineProperty(response, `type`, { value: `basic` });
    if (init.redirected === true) {
        Object.defineProperty(response, `redirected`, { value: true });
    }
    return response;
};
// A second delivery of the same answer: clone() makes a plain Response, so what was pinned on the first is pinned again.
const copyOf = (response: Response): Response => {
    const copy = response.clone();
    Object.defineProperty(copy, `type`, { value: response.type });
    Object.defineProperty(copy, `redirected`, { value: response.redirected });
    return copy;
};
const page = (body: string, status = 200): Response => ours(body, { status, headers: { "content-type": `text/html; charset=utf-8` } });
const script = (body: string, headers: Record<string, string> = {}): Response => ours(body, { headers: { "content-type": `text/javascript`, ...headers } });

const keyOf = (target: string | FakeRequest): string => new URL(target instanceof FakeRequest ? target.url : target, ORIGIN).href;

class FakeCache {
    readonly entries = new Map<string, Response>();
    async match(request: string | FakeRequest): Promise<Response | undefined> {
        return this.entries.get(keyOf(request))?.clone();
    }
    async put(request: string | FakeRequest, response: Response): Promise<void> {
        this.entries.set(keyOf(request), response);
    }
    async keys(): Promise<FakeRequest[]> {
        return [...this.entries.keys()].map((url) => request(url));
    }
    async delete(request: string | FakeRequest): Promise<boolean> {
        return this.entries.delete(keyOf(request));
    }
}

class FakeCaches {
    readonly stores = new Map<string, FakeCache>();
    async open(name: string): Promise<FakeCache> {
        const store = this.stores.get(name) ?? new FakeCache();
        this.stores.set(name, store);
        return store;
    }
    async keys(): Promise<string[]> {
        return [...this.stores.keys()];
    }
    async delete(name: string): Promise<boolean> {
        return this.stores.delete(name);
    }
    async match(request: string | FakeRequest): Promise<Response | undefined> {
        for (const store of this.stores.values()) {
            const hit = await store.match(request);
            if (hit !== undefined) {
                return hit;
            }
        }
        return undefined;
    }
    async text(name: string, url: string): Promise<string | undefined> {
        return (await this.stores.get(name)?.match(url))?.text();
    }
}

const request = (url: string, options: { method?: string; mode?: string; headers?: Record<string, string> } = {}): FakeRequest =>
    new FakeRequest(new URL(url, ORIGIN).href, options.method ?? `GET`, options.mode ?? `cors`, new Headers(options.headers ?? {}));
const navigation = (path: string): FakeRequest => request(path, { mode: `navigate` });

interface Dispatched {
    readonly answer: Promise<Response> | undefined;
    readonly settled: () => Promise<void>;
}

// One worker, booted from the real file. `network` answers every fetch the worker makes, by URL; a missing entry is a
// failed connection. `timersFire` lets the navigation's patience run out at once.
const boot = (options: { manifest?: PrecacheManifest | null; network?: Record<string, Answer>; timersFire?: boolean } = {}) => {
    const caches = new FakeCaches();
    const listeners = new Map<string, (event: unknown) => void>();
    const fetched: string[] = [];
    const network = options.network ?? {};
    const fetch = async (target: string | FakeRequest): Promise<Response> => {
        const url = keyOf(target);
        fetched.push(url);
        const answer = network[new URL(url).pathname];
        if (answer instanceof Later) {
            return answer.response;
        }
        if (answer instanceof Response) {
            return copyOf(answer);
        }
        throw answer ?? new TypeError(`Failed to fetch`);
    };
    const setTimeout = (callback: () => void, ms: number): number => {
        if (options.timersFire === true && ms === PATIENCE_MS) {
            queueMicrotask(callback);
        }
        return 0;
    };
    const scope = {
        caches,
        fetch,
        URL,
        Headers,
        Response,
        console: { warn: () => undefined, log: () => undefined },
        setTimeout,
        clearTimeout: () => undefined,
        location: new URL(`${ORIGIN}/sw.js`),
        skipWaiting: () => Promise.resolve(),
        clients: { claim: () => Promise.resolve() },
        addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    };
    const manifest = options.manifest === undefined ? MANIFEST : options.manifest;
    // The worker's global is `self`: the realm's global object, here the scope itself.
    runInNewContext(manifest === null ? WORKER_SOURCE : withPrecache(WORKER_SOURCE, manifest), Object.assign(scope, { self: scope }));

    const dispatch = (type: string, extra: Record<string, unknown> = {}): Dispatched => {
        let answer: Promise<Response> | undefined;
        const waits: Promise<unknown>[] = [];
        listeners.get(type)?.({
            ...extra,
            respondWith: (promise: Promise<Response>) => {
                answer = promise;
            },
            waitUntil: (promise: Promise<unknown>) => {
                waits.push(promise);
            },
        });
        // Settles everything the event kept alive, including what it added while answering.
        const settled = async (): Promise<void> => {
            await answer?.catch(() => undefined);
            for (let seen = 0; seen < waits.length; seen = waits.length) {
                await Promise.all(waits);
            }
        };
        return { answer, settled };
    };
    const ask = (asked: FakeRequest): Dispatched => dispatch(`fetch`, { request: asked });
    return { caches, fetched, listeners, dispatch, ask };
};

const SHELL = `intentic-offline-shell`;
const ASSETS = `intentic-offline-assets`;
const PRECACHE = `intentic-offline-precache-${MANIFEST.build}`;

const withShell = async (worker: ReturnType<typeof boot>, body = `<html>kept shell</html>`): Promise<void> => {
    await (await worker.caches.open(SHELL)).put(`/`, page(body));
};

describe(`the app's service worker, without a precache list (the dev server, the demo)`, () => {
    it(`answers no request and keeps nothing: it is only the push worker`, async () => {
        const worker = boot({ manifest: null, network: { "/": page(`<html>live</html>`) } });
        await worker.dispatch(`install`).settled();
        expect(worker.ask(navigation(`/agents`)).answer).toBeUndefined();
        expect(worker.ask(request(`/assets/index-b2.js`)).answer).toBeUndefined();
        expect(await worker.caches.keys()).toEqual([]);
        expect([...worker.listeners.keys()].sort()).toEqual([`activate`, `fetch`, `install`, `notificationclick`, `push`]);
    });
});

describe(`what the worker never touches`, () => {
    const worker = boot();
    it.each([
        [`another origin (the api)`, request(`https://api.intentic.dev/rpc/sandbox/list`)],
        [`a sandbox daemon`, request(`https://sandbox-82789f4106b4.sbx.intentic.dev/system/session`)],
        [`a write`, request(`/assets/index-b2.js`, { method: `POST` })],
        [`a request carrying credentials`, request(`/assets/index-b2.js`, { headers: { authorization: `Bearer x` } })],
        [`a range of a file`, request(`/assets/wallpaper/dawn.mp4`, { headers: { range: `bytes=0-99` } })],
        [`the build stamp`, request(`/build.json`)],
        [`fonts (the HTTP cache keeps them)`, request(`/fonts/public-sans-100-900-latin.woff2`)],
        [`analytics`, request(`/wire/e/`)],
        [`a navigation to the api path`, navigation(`/api/auth/get-session`)],
        [`a navigation to a static file`, navigation(`/manifest.webmanifest`)],
        [`a navigation to an asset`, navigation(`/assets/intentic-logo.png`)],
        [`a navigation to the worker itself`, navigation(`/sw.js`)],
    ])(`%s`, (_what, asked) => {
        expect(worker.ask(asked).answer).toBeUndefined();
    });
});

describe(`a navigation`, () => {
    it(`is the network's answer when it is good, and that answer becomes the kept shell`, async () => {
        const worker = boot({ network: { "/agents": page(`<html>fresh</html>`) } });
        const asked = worker.ask(navigation(`/agents?sandbox=cm1`));
        expect(await (await asked.answer)?.text()).toBe(`<html>fresh</html>`);
        await asked.settled();
        expect(await worker.caches.text(SHELL, `/`)).toBe(`<html>fresh</html>`);
    });

    it(`is the kept shell when the connection fails`, async () => {
        const worker = boot();
        await withShell(worker);
        expect(await (await worker.ask(navigation(`/workspace/src/main.ts`)).answer)?.text()).toBe(`<html>kept shell</html>`);
    });

    it.each([500, 502, 503, 504, 520, 522, 530, 599])(`is the kept shell when the origin answers %i`, async (status) => {
        const worker = boot({ network: { "/": page(`<h1>origin down</h1>`, status) } });
        await withShell(worker);
        const asked = worker.ask(navigation(`/`));
        expect(await (await asked.answer)?.text()).toBe(`<html>kept shell</html>`);
        await asked.settled();
        expect(await worker.caches.text(SHELL, `/`), `an error page never replaces the shell`).toBe(`<html>kept shell</html>`);
    });

    it.each([404, 501])(`is the network's answer when it is %i, which is an answer and not an outage`, async (status) => {
        const worker = boot({ network: { "/nope": page(`not here`, status) } });
        await withShell(worker);
        expect((await worker.ask(navigation(`/nope`)).answer)?.status).toBe(status);
    });

    it(`is the origin's error page when nothing is kept yet`, async () => {
        const worker = boot({ network: { "/": page(`<h1>Error 1033</h1>`, 530) } });
        const answer = await worker.ask(navigation(`/`)).answer;
        expect([answer?.status, await answer?.text()]).toEqual([530, `<h1>Error 1033</h1>`]);
    });

    it(`fails as the network failed when nothing is kept yet`, async () => {
        const worker = boot();
        await expect(worker.ask(navigation(`/`)).answer).rejects.toThrow(`Failed to fetch`);
    });

    it(`is the kept shell once the network has kept it waiting past its patience, and a late good page still replaces it`, async () => {
        let deliver: (response: Response) => void = () => undefined;
        const late = new Promise<Response>((settle) => {
            deliver = settle;
        });
        const worker = boot({ timersFire: true, network: { "/": new Later(late) } });
        await withShell(worker);
        const asked = worker.ask(navigation(`/`));
        expect(await (await asked.answer)?.text()).toBe(`<html>kept shell</html>`);
        deliver(page(`<html>late but good</html>`));
        await asked.settled();
        expect(await worker.caches.text(SHELL, `/`)).toBe(`<html>late but good</html>`);
    });

    it.each([
        [`a redirect`, ours(`<html>moved</html>`, { status: 200, redirected: true, headers: { "content-type": `text/html` } })],
        [`a page that is not HTML`, ours(`{}`, { status: 200, headers: { "content-type": `application/json` } })],
    ])(`never keeps %s as the shell`, async (_what, response) => {
        const worker = boot({ network: { "/": response } });
        await withShell(worker);
        await worker.ask(navigation(`/`)).settled();
        expect(await worker.caches.text(SHELL, `/`)).toBe(`<html>kept shell</html>`);
    });
});

describe(`a hashed asset`, () => {
    it(`is fetched once and then served from the cache`, async () => {
        const worker = boot({ network: { "/assets/Agents-d4.js": script(`export default 1`) } });
        const first = worker.ask(request(`/assets/Agents-d4.js`));
        expect(await (await first.answer)?.text()).toBe(`export default 1`);
        await first.settled();
        const second = await worker.ask(request(`/assets/Agents-d4.js`)).answer;
        expect([await second?.text(), worker.fetched.filter((url) => url.endsWith(`/assets/Agents-d4.js`)).length]).toEqual([`export default 1`, 1]);
    });

    it.each([
        [`marked no-store`, script(`x`, { "cache-control": `no-store` })],
        [`marked private`, script(`x`, { "cache-control": `private, max-age=60` })],
        [`a partial answer`, ours(`x`, { status: 206 })],
        [`a missing file`, ours(`x`, { status: 404 })],
    ])(`is not kept when %s`, async (_what, response) => {
        const worker = boot({ network: { "/assets/a-1.js": response } });
        await worker.ask(request(`/assets/a-1.js`)).settled();
        expect(await worker.caches.match(`/assets/a-1.js`)).toBeUndefined();
    });
});

describe(`the runtime config and the import map's shims`, () => {
    it.each([`/assets/js/env.js`, `/ext-shims/vue.js`])(`%s is asked every time, and the kept copy answers only an outage`, async (path) => {
        const online = boot({ network: { [path]: script(`live`, { "cache-control": `no-store` }) } });
        await online.ask(request(path)).settled();
        const second = await online.ask(request(path)).answer;
        expect([await second?.text(), online.fetched.length]).toEqual([`live`, 2]);

        const offline = boot();
        await (await offline.caches.open(ASSETS)).put(path, script(`kept`));
        expect(await (await offline.ask(request(path)).answer)?.text()).toBe(`kept`);

        const deadOrigin = boot({ network: { [path]: ours(`down`, { status: 530 }) } });
        await (await deadOrigin.caches.open(ASSETS)).put(path, script(`kept`));
        expect(await (await deadOrigin.ask(request(path)).answer)?.text()).toBe(`kept`);
    });

    it(`answers an outage with the copy kept on use before the one the install fetched`, async () => {
        const worker = boot({ network: { "/assets/js/env.js": ours(`down`, { status: 530 }) } });
        await (await worker.caches.open(PRECACHE)).put(`/assets/js/env.js`, script(`from the install`));
        expect(await (await worker.ask(request(`/assets/js/env.js`)).answer)?.text(), `only the install's copy`).toBe(`from the install`);
        await (await worker.caches.open(ASSETS)).put(`/assets/js/env.js`, script(`from the last visit`));
        expect(await (await worker.ask(request(`/assets/js/env.js`)).answer)?.text()).toBe(`from the last visit`);
    });
});

describe(`install and activate`, () => {
    it(`keeps this build's shell and critical chunks, and a file that fails does not fail the install`, async () => {
        const worker = boot({
            network: {
                "/": page(`<html>build shell</html>`),
                "/assets/js/env.js": script(`window.env = {}`, { "cache-control": `no-store` }),
                "/assets/index-a1.css": ours(`body{}`, { headers: { "content-type": `text/css` } }),
                "/assets/index-b2.js": script(`entry`),
            },
        });
        await worker.dispatch(`install`).settled();
        expect(await worker.caches.text(SHELL, `/`)).toBe(`<html>build shell</html>`);
        const kept = [...(worker.caches.stores.get(PRECACHE)?.entries.keys() ?? [])].map((url) => new URL(url).pathname).sort();
        expect(kept, `Shell-c3.js failed to fetch and is skipped`).toEqual([`/assets/index-a1.css`, `/assets/index-b2.js`, `/assets/js/env.js`]);
    });

    it(`keeps this build's precache and the one before it, and holds the kept chunks to their cap, oldest out first`, async () => {
        const worker = boot();
        for (const build of [`1790000000000`, `1791000000000`, `1792000000000`, MANIFEST.build]) {
            await worker.caches.open(`intentic-offline-precache-${build}`);
        }
        const assets = await worker.caches.open(ASSETS);
        for (let index = 0; index < 405; index += 1) {
            await assets.put(`/assets/chunk-${index}.js`, script(`${index}`));
        }
        await worker.dispatch(`activate`).settled();
        expect((await worker.caches.keys()).filter((name) => name.includes(`precache`)).sort()).toEqual([
            `intentic-offline-precache-1792000000000`,
            PRECACHE,
        ]);
        const left = [...assets.entries.keys()];
        expect([left.length, new URL(left[0] ?? ORIGIN).pathname]).toEqual([400, `/assets/chunk-5.js`]);
    });
});
