/* THE DEMO'S ELEMENT WORKER: answers the addresses the editor hands straight to the browser (a <video>'s source, a
download link, a running app's frame) from the demo tab's own in-memory sandbox, which only that tab holds.

The editor passes every such address through its element-address seam (web client/endpoint/elementAddress.ts); the
demo names `<base>__sandbox/<world>/<host>/<path>` for each (src/world/elements.ts), on the page's own origin and under
this worker's scope, since a worker sees a navigation (a download, a frame) only to its own origin. Each request is
asked of the tab whose world minted the address over a BroadcastChannel, and its answer (status, headers, bytes, a
Range window included) is handed back as it came. Everything else under the scope passes through untouched.

Plain JavaScript, served as it is (vite.config.ts `elementWorker`): a worker's script must sit at the scope it controls. */

const CHANNEL = `intentic-demo-elements`;
// How long a tab gets to answer before the address is reported dead: a closed tab never will.
const PATIENCE_MS = 15000;

const prefix = new URL(`__sandbox/`, self.registration.scope).pathname;
const channel = new BroadcastChannel(CHANNEL);
const waiting = new Map();

channel.addEventListener(`message`, (event) => {
    const answer = event.data;
    if (answer?.kind !== `answer`) {
        return;
    }
    waiting.get(answer.id)?.(answer);
    waiting.delete(answer.id);
});

self.addEventListener(`install`, () => self.skipWaiting());
self.addEventListener(`activate`, (event) => event.waitUntil(self.clients.claim()));

const closed = () =>
    new Response(`The demo tab this address came from is closed or reloaded: open the demo and try again.`, {
        status: 504,
        headers: { "content-type": `text/plain; charset=utf-8` },
    });

const relay = async (request, url) => {
    const [world, host, ...rest] = url.pathname.slice(prefix.length).split(`/`);
    const target = `https://${host}/${rest.join(`/`)}${url.search}`;
    const id = crypto.randomUUID();
    const body = request.method === `GET` || request.method === `HEAD` ? undefined : await request.arrayBuffer();
    const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => {
            waiting.delete(id);
            resolve(undefined);
        }, PATIENCE_MS);
        waiting.set(id, (said) => {
            clearTimeout(timer);
            resolve(said);
        });
        channel.postMessage({ kind: `ask`, id, world, url: target, method: request.method, headers: [...request.headers], body });
    });
    if (answer === undefined) {
        return closed();
    }
    const empty = request.method === `HEAD` || [204, 304].includes(answer.status);
    return new Response(empty ? null : answer.body, { status: answer.status, headers: answer.headers });
};

self.addEventListener(`fetch`, (event) => {
    const url = new URL(event.request.url);
    if (url.origin === self.location.origin && url.pathname.startsWith(prefix)) {
        event.respondWith(relay(event.request, url));
    }
});
