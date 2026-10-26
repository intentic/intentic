import { mkdir, mkdtemp, rm, writeFile,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    BROWSER_ARGS_SOURCE,
    browserArgsOf,
    browserArguments,
    describeRequests,
    isNavigation,
    offlineStatus,
    OFFLINE_PAGE,
    type OutageStub,
    pageAt,
    pageTargets,
    reportOf,
    type SeenRequest,
    startOutageStub,
    unresolvable,
} from "./outage.js";

// The outage tier's pure half and its stub, which run anywhere; the tier itself (tier-outage.ts) needs the installed app
// on Windows.

const REPO = resolve(import.meta.dir, `..`, `..`, `..`);

const seen = (method: string, path: string, accept: string): SeenRequest => ({ method, path, accept, userAgent: `test`, at: 0 });

test(`the app's own WebView2 arguments are read from the source the build is made from`, async () => {
    const args = browserArgsOf(await readFile(join(REPO, BROWSER_ARGS_SOURCE), `utf8`));
    expect(args).toEqual(expect.any(String));
    // What the face's loopback calls need, and what a scenario would silently lose if the tier passed only its own.
    expect(args).toContain(`--disable-features=`);
    expect(args).toContain(`LocalNetworkAccessChecks`);
    expect(args).toContain(`msSmartScreenProtection`);
    expect(args).toContain(`--autoplay-policy=no-user-gesture-required`);
    // Comments between the pieces are not arguments.
    expect(args).not.toContain(`//`);
    expect(args).not.toContain(`Fetch, subresources`);
});

test(`a concat! of literals with comments between them is joined, and a file without it reads as nothing`, () => {
    const source = [
        `pub(super) const BROWSER_ARGS: &str = concat!(`,
        `    "--disable-features=",`,
        `    "a,", // why a`,
        `    // why b, with "quotes" in it (and a call(); that ends nothing)`,
        `    "b,",`,
        `    "c --url=https://x.test/y",`,
        `    " --flag"`,
        `);`,
    ].join(`\n`);
    expect(browserArgsOf(source)).toBe(`--disable-features=a,b,c --url=https://x.test/y --flag`);
    expect(browserArgsOf(`const OTHER: &str = "x";`)).toBeUndefined();
});

test(`a scenario's arguments follow the app's, and unresolvable hosts are one quoted rule list`, () => {
    expect(unresolvable([`app.e2e.test`, `api.e2e.test`])).toBe(`--host-resolver-rules="MAP app.e2e.test ~NOTFOUND, MAP api.e2e.test ~NOTFOUND"`);
    expect(browserArguments(`--a --b`, [`--remote-debugging-port=9`, `--c`])).toBe(`--a --b --remote-debugging-port=9 --c`);
    expect(browserArguments(``, [`--c`])).toBe(`--c`);
});

test(`only a GET for HTML is a load of the workspace; checks, reports and icons are not`, () => {
    expect(isNavigation(seen(`GET`, `/`, `text/html,application/xhtml+xml,*/*;q=0.8`))).toBe(true);
    expect(isNavigation(seen(`GET`, `/`, `*/*`))).toBe(false);
    expect(isNavigation(seen(`HEAD`, `/`, `text/html`))).toBe(false);
    expect(isNavigation(seen(`GET`, `/__report?desktop=true`, `text/html`))).toBe(false);
    expect(isNavigation(seen(`GET`, `/favicon.ico`, `text/html`))).toBe(false);
});

test(`the DevTools listing is read as its pages, and the offline page's status is found among them`, () => {
    const listing = JSON.stringify([
        { type: `service_worker`, url: `https://x/sw.js` },
        { type: `page`, url: `${OFFLINE_PAGE}?to=http%3A%2F%2F127.0.0.1%3A5%2F&status=http-530&face=x` },
        { type: `page` },
    ]);
    const pages = pageTargets(listing);
    expect(pages).toEqual([{ type: `page`, url: `${OFFLINE_PAGE}?to=http%3A%2F%2F127.0.0.1%3A5%2F&status=http-530&face=x` }]);
    expect(offlineStatus(pages)).toBe(`http-530`);
    expect(offlineStatus(pageTargets(JSON.stringify({ type: `page`, url: `http://127.0.0.1:5/` })))).toBeUndefined();
    expect(pageTargets(``)).toEqual([]);
});

test(`a page is at an origin, and at a path when one is asked`, () => {
    const pages = pageTargets(JSON.stringify([{ type: `page`, url: `http://127.0.0.1:5/platform-unavailable?returnTo=%2F` }]));
    expect(pageAt(pages, `http://127.0.0.1:5`)).toBe(true);
    expect(pageAt(pages, `http://127.0.0.1:5`, `/platform-unavailable`)).toBe(true);
    expect(pageAt(pages, `http://127.0.0.1:5`, `/`)).toBe(false);
    expect(pageAt(pages, `http://127.0.0.1:6`)).toBe(false);
    expect(pageAt(pageTargets(JSON.stringify([{ type: `page`, url: `not a url` }])), `http://127.0.0.1:5`)).toBe(false);
});

test(`a report says what the page was told, and a request list says which were loads`, () => {
    expect(reportOf(new URLSearchParams(`desktop=true&machineFace=false`))).toEqual({ desktop: true, machineFace: false });
    expect(reportOf(new URLSearchParams(``))).toEqual({ desktop: false, machineFace: false });
    expect(describeRequests([])).toBe(`(the stub was asked for nothing)`);
    expect(describeRequests([seen(`GET`, `/`, `text/html`), seen(`HEAD`, `/`, ``)])).toBe(`GET / accept=text/html [load]\nHEAD / accept=- [check]`);
});

describe(`the stub that plays the workspace's address`, () => {
    let stub: OutageStub | undefined;
    const made: string[] = [];
    afterEach(async () => {
        await stub?.close();
        stub = undefined;
        await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    test(`answers Cloudflare's kind of error until told otherwise, and counts the loads`, async () => {
        stub = await startOutageStub({ kind: `error`, status: 530 });
        const failing = await fetch(stub.origin, { headers: { accept: `text/html` } });
        expect(failing.status).toBe(530);
        expect(failing.headers.get(`server`)).toBe(`cloudflare`);
        expect(await failing.text()).toContain(`Cloudflare`);
        await fetch(stub.origin, { method: `HEAD` });
        expect(stub.navigations()).toBe(1);
        expect(stub.requests()).toHaveLength(2);

        stub.setMode({ kind: `ready` });
        const ready = await fetch(stub.origin, { headers: { accept: `text/html` } });
        expect(ready.status).toBe(200);
        expect(await ready.text()).toContain(`__INTENTIC_DESKTOP__`);
        expect(stub.navigations()).toBe(2);
    });

    test(`keeps what the page reported, and does not count it as a load`, async () => {
        stub = await startOutageStub({ kind: `ready` });
        const reported = await fetch(`${stub.origin}/__report?desktop=true&machineFace=false`, { headers: { accept: `text/html` } });
        expect(reported.status).toBe(204);
        expect(stub.reports()).toEqual([{ desktop: true, machineFace: false }]);
        expect(stub.navigations()).toBe(0);
    });

    test(`serves an editor build with its routes falling back to index.html and the API pointed nowhere`, async () => {
        const dist = await mkdtemp(join(tmpdir(), `outage-dist-`));
        made.push(dist);
        await mkdir(join(dist, `assets`, `js`), { recursive: true });
        await writeFile(join(dist, `index.html`), `<!doctype html><title>editor</title>`);
        await writeFile(join(dist, `assets`, `js`, `env.js`), `window.env = { api: { url: "$API_URL" }, posthog: "$POSTHOG_KEY" };`);
        stub = await startOutageStub({ kind: `editor`, dist, apiUrl: `https://api.e2e.test` });

        const env = await fetch(`${stub.origin}/assets/js/env.js`);
        expect(env.headers.get(`content-type`)).toContain(`javascript`);
        const script = await env.text();
        expect(script).toContain(`"https://api.e2e.test"`);
        // Only the API: analytics stays the literal the deployment leaves off.
        expect(script).toContain(`$POSTHOG_KEY`);

        const route = await fetch(`${stub.origin}/platform-unavailable?returnTo=%2F`);
        expect(route.status).toBe(200);
        expect(await route.text()).toContain(`<title>editor</title>`);
        // Nothing outside the build is served, however the path is spelled.
        expect(await (await fetch(`${stub.origin}/..%2F..%2Fetc%2Fpasswd`)).text()).toContain(`<title>editor</title>`);
    });
});
