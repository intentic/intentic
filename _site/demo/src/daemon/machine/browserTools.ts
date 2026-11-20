import type { BrowserDownload, BrowserPermission, PermissionSetting } from "@intentic/sandbox-contract/schemas/browser-tools";
import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import { refuse } from "@intentic/contract-serve";
import { json } from "../../transport";
import { listeners } from "../board/roster";
import type { Doors } from "../doors";

// What the visitor's own window does besides its pages (the daemon's browser/downloads, uploads, permissions, devtools),
// answered from a record this page load keeps: a download list with one still arriving, a file chooser on any page
// whose address asks for an upload, a location ask on a maps page, and each site's permissions as the visitor sets them.
// Nothing is fetched or stored anywhere; a saved download says where it would have gone.

const STARTED = Date.now();
// The one still arriving fills over a minute from when the page loaded, then lands.
const ARRIVING_MS = 60_000;
const ARRIVING_BYTES = 48 * 1024 * 1024;

const removed = new Set<string>();
const answered = new Set<string>();
const sites = new Map<string, Map<BrowserPermission, PermissionSetting>>();

const push = (): void => {
    for (const listener of listeners) {
        listener({ kind: `runtimeChanged`, domains: [`browsers`] });
    }
};

// The list is told every two seconds while the one download arrives, as the daemon tells a window's progress.
const ticking = setInterval(() => {
    push();
    if (Date.now() - STARTED >= ARRIVING_MS) {
        clearInterval(ticking);
    }
}, 2_000);

const downloads = (now: number): BrowserDownload[] => {
    const progress = Math.min(1, (now - STARTED) / ARRIVING_MS);
    const listed: BrowserDownload[] = [
        {
            id: `dl-dataset`,
            name: `orders-2026-q3.parquet`,
            url: `https://data.acme-shop.test/exports/orders-2026-q3.parquet`,
            state: progress < 1 ? `progress` : `done`,
            receivedBytes: Math.round(ARRIVING_BYTES * progress),
            totalBytes: ARRIVING_BYTES,
            startedAt: STARTED,
            finishedAt: progress < 1 ? undefined : STARTED + ARRIVING_MS,
        },
        {
            id: `dl-invoice`,
            name: `Invoice INV-2041.pdf`,
            url: `https://billing.stripe.com/invoice/acct_1Nv/inv_2041/pdf`,
            state: `done`,
            receivedBytes: 182_311,
            totalBytes: 182_311,
            startedAt: STARTED - 12 * 60_000,
            finishedAt: STARTED - 12 * 60_000,
        },
        {
            id: `dl-logo`,
            name: `acme-logo-pack.zip`,
            url: `https://acme-shop.test/press/acme-logo-pack.zip`,
            state: `canceled`,
            receivedBytes: 3_201_334,
            totalBytes: 9_800_000,
            startedAt: STARTED - 3 * 3_600_000,
            finishedAt: STARTED - 3 * 3_600_000 + 4_000,
        },
    ];
    return listed.filter((download) => !removed.has(download.id));
};

// A web page's site; a blank tab (about:blank, whose origin reads `null`) has none.
const originOf = (url: string | undefined): string | undefined =>
    url !== undefined && URL.canParse(url) && new URL(url).protocol.startsWith(`http`) ? new URL(url).origin : undefined;

/** The visitor's window with what it holds besides its pages: its downloads, and what its page in front asks. */
export const withBrowserTools = (session: BrowserSession, now: number): BrowserSession => {
    const front = session.pages.find((page) => page.active);
    const origin = originOf(front?.url);
    const chooser = front !== undefined && /upload/u.test(front.url) && !answered.has(`chooser:${front.id}`);
    const locating = front !== undefined && origin !== undefined && new URL(origin).host.startsWith(`maps.`) && sites.get(origin)?.get(`geolocation`) === undefined;
    return {
        ...session,
        downloads: downloads(now),
        fileChooser: chooser ? { id: `chooser:${front.id}`, pageId: front.id, multiple: true, accept: [`.pdf`, `image/*`] } : undefined,
        permissionAsk: locating ? { id: `ask:${front.id}`, pageId: front.id, origin, permission: `geolocation` } : undefined,
    };
};

const settingOf = (origin: string, permission: BrowserPermission): PermissionSetting => sites.get(origin)?.get(permission) ?? `ask`;
const setSetting = (origin: string, permission: BrowserPermission, setting: PermissionSetting): void => {
    const site = sites.get(origin) ?? new Map<BrowserPermission, PermissionSetting>();
    site.set(permission, setting);
    sites.set(origin, site);
};

// The visitor's site permissions as they set them; a first look at the shop's own site shows one already allowed.
setSetting(`https://acme-shop.test`, `notifications`, `allow`);

export const browserDoors = {
    downloads: () => downloads(Date.now()),
    downloadTicket: ({ id }) => ({ ticket: `demo-download-${id}`, expiresAt: Date.now() + 300_000 }),
    saveDownload: ({ id, folder }) => {
        const download = downloads(Date.now()).find((one) => one.id === id && one.state === `done`) ?? refuse(`That download has not finished, or is gone.`, 404);
        return { path: `${folder ?? `downloads`}/${download.name}` };
    },
    cancelDownload: () => ({ ok: true }),
    removeDownload: ({ id }) => {
        removed.add(id);
        push();
        return { ok: true };
    },
    answerFileChooser: ({ chooser }) => {
        answered.add(chooser);
        push();
        return { ok: true };
    },
    dropFiles: () => ({ ok: true }),
    answerPermission: ({ ask, setting }) => {
        const pageOrigin = `https://maps.acme-shop.test`;
        answered.add(ask);
        setSetting(pageOrigin, `geolocation`, setting);
        push();
        return { ok: true };
    },
    site: ({ origin }) => ({
        origin,
        permissions: ([`notifications`, `geolocation`, `clipboard-read`, `camera`, `microphone`] as const).map((permission) => ({ permission, setting: settingOf(origin, permission) })),
        location: false,
    }),
    setSitePermission: ({ origin, permission, setting }) => {
        setSetting(origin, permission, setting);
        push();
        return { ok: true };
    },
    clearSiteData: () => ({ ok: true }),
    printPage: ({ pageId }) => ({
        id: `dl-print-${pageId}`,
        name: `Printed page.pdf`,
        url: `https://acme-shop.test/`,
        state: `done`,
        receivedBytes: 96_000,
        totalBytes: 96_000,
        startedAt: Date.now(),
        finishedAt: Date.now(),
    }),
    viewSource: () => ({}),
    // No Chromium here to inspect: the frame opens on the demo's own page saying so. Answered as the fixture's refusal
    // (403), as pages.handler.ts does, so the smoke run tells it apart from a procedure that broke.
    devtools: () => refuse(`The demo has no browser to inspect: DevTools opens on a real sandbox.`, 403),
} satisfies Doors<`browser`>;

// The raw half: an upload is taken whole and dropped, and a saved download is a short text file of its own name.
export const browserRaw = {
    "POST /browser/uploads": () => json({ ok: true }),
    "GET /browser/downloads/file": ({ url }: { readonly url: URL }) =>
        new Response(`A demo download (${url.searchParams.get(`ticket`) ?? ``}): the real one streams from the sandbox.`, {
            headers: { "content-type": `text/plain`, "content-disposition": `attachment; filename="demo-download.txt"` },
        }),
};
