import type { GroupSamples } from "./context.ts";

// Sent in this order against one live fixture, so each write is undone by a later one: a folder made, moved, copied and
// deleted; the dropped archive unpacked and removed; a repository cloned in, which the per-repo apps, tests and graph
// samples then read.
export const workspaceSamples: GroupSamples<`workspace`> = () => ({
    tree: {},
    children: { path: `web` },
    file: { path: `web/src/lib/checkout.ts` },
    dimensions: { paths: [`web/public/logo.svg`] },
    resolve: { path: `lib/checkout.ts` },
    derived: { path: `drop/brand-kit.zip` },
    derive: { path: `drop/brand-kit.zip` },
    mkdir: { path: `web/src/drafts/new` },
    move: { from: `web/src/drafts`, to: `web/src/sketches` },
    copy: { from: `web/src/sketches`, to: `web/src/sketches-copy` },
    // The README goes to the trash and comes straight back: the first id the fixture hands out.
    delete: { path: `web/README.md` },
    restore: { trashed: `demo-00000001` },
    extract: { path: `drop/brand-kit.zip` },
    install: { dirs: [`web`] },
    repos: undefined,
    addRepo: { name: `storefront-kit`, cloneUrl: `https://github.com/acme/storefront-kit.git` },
    createRepo: { name: `ideas` },
    modules: undefined,
    templates: undefined,
    addApps: { repo: `storefront-kit`, apps: [{ template: `worker`, name: `emails` }] },
    appsList: { repo: `storefront-kit` },
    startApp: { repo: `storefront-kit`, app: `storefront` },
    stopApp: { repo: `storefront-kit`, app: `storefront` },
    runTests: { repo: `storefront-kit`, session: `storefront__test`, dirs: [`_apps/storefront`] },
    packageGraph: { repo: `storefront-kit` },
    packageModules: { repo: `storefront-kit`, package: `@storefront-kit/ui` },
    health: { repo: `web` },
    // The order chime plays; the shop's two static pages leave as one ZIP; the offline page previews with its edits.
    mediaTicket: { path: `web/public/sounds/order-placed.wav` },
    downloadTicket: { paths: [`web/public/offline.html`, `web/public/offline.css`] },
    previewTicket: { path: `web/public/offline.html`, source: `<!doctype html><title>Back soon</title><h1>Back in five minutes</h1>` },
    search: { query: `checkout` },
    searchStream: { query: `checkout`, mode: `find` },
});
