import { fillPattern, matchPattern } from "./patterns.js";
import { type LinkExtras, page, type PageLink, type PageName } from "./app-pages.js";

// THE ADDRESSES FROM BEFORE FRAMES (before 2026-11-04), read into the pages they meant. Every one of them named a page of
// "the sandbox this browser had open last", so they are still out there and still mean something: an installed Android
// app or desktop app hands them over, a daemon's push message points at one, a bookmark or an e-mail holds one. The
// editor's router sends each to its page in its sandbox (`?sandbox=<id>` when the link named one, the one last opened
// otherwise), and a native app that reads addresses is handed this form back (`legacyPathOf`), so neither has to change
// in step with the editor.

/** What an old address meant: its page, and the frame when it was an account page reached with no sandbox needed. */
export interface LegacyTarget {
    readonly link: PageLink;
    /** Home's frame for the account's pages, which must open with no sandbox at all; inside the sandbox otherwise. */
    readonly frame: `inside` | `home`;
}

type Query = Readonly<Record<string, string>>;

interface LegacyRoute {
    readonly pattern: string;
    readonly to: (params: Readonly<Record<string, string>>, query: Query, hash: string) => LegacyTarget;
}

const inside = (link: PageLink): LegacyTarget => ({ link, frame: `inside` });

const extras = (query: Query, hash: string): LinkExtras => ({ query, hash });

// A redirect the old table already carried, kept with it: its words say why each old address is where it is now.
const withoutKey = (query: Query, key: string): Query => Object.fromEntries(Object.entries(query).filter(([name]) => name !== key));

// Most specific first: `sandbox/devices` before `sandbox/:tab?`.
const LEGACY_ROUTES: readonly LegacyRoute[] = [
    { pattern: `chat`, to: (_p, q, h) => inside(page.chat(extras(q, h))) },
    { pattern: `agents`, to: (_p, q, h) => inside(page.agents(extras(q, h))) },
    // The Needs you inbox until 2026-10-12, when each of its rows went back to the board's tile that already badged it.
    { pattern: `needs`, to: (_p, q, h) => inside(page.agents(extras(q, h))) },
    { pattern: `agents/:id`, to: (p, q, h) => inside(page.agent(p[`id`] ?? ``, extras(q, h))) },
    { pattern: `agents/:id/pages/:page`, to: (p, q, h) => inside(page.agentPage(p[`id`] ?? ``, p[`page`] ?? ``, extras(q, h))) },
    { pattern: `workspace/:path(.*)*`, to: (p, q, h) => inside(page.workspace(p[`path`], extras(q, h))) },
    { pattern: `browsers/:tab(.*)?`, to: (p, q, h) => inside(page.browsers(p[`tab`], extras(q, h))) },
    // The sandbox's own desktop was a view of its own until it became a tab of Browsers (2026-10-08).
    { pattern: `desktop`, to: (_p, q, h) => inside(page.browsers(`desktop`, extras(q, h))) },
    // The live app's home until it, too, became a tab of Browsers: `?target=` names the app.
    {
        pattern: `preview`,
        to: (_p, q, h) => {
            const target = q[`target`];
            return inside(page.browsers(target === undefined || target === `` ? undefined : `preview:${target}`, extras(withoutKey(q, `target`), h)));
        },
    },
    { pattern: `devices`, to: (_p, q, h) => inside(page.devices(extras(q, h))) },
    { pattern: `sandbox/devices`, to: (_p, q, h) => inside(page.devices(extras(q, h))) },
    { pattern: `capabilities/:entry?`, to: (p, q, h) => inside(page.capabilities(p[`entry`], extras(q, h))) },
    // The connect page's address until it became the sandbox's Models.
    { pattern: `connect`, to: (_p, q, h) => inside(page.sandboxSettings(`models`, extras(q, h))) },
    { pattern: `ext/:ext/:key?`, to: (p, q, h) => inside(page.extension(p[`ext`] ?? ``, p[`key`], extras(q, h))) },
    { pattern: `terminal`, to: (_p, q, h) => inside(page.terminal(extras(q, h))) },
    { pattern: `menu`, to: (_p, q, h) => inside(page.menu(extras(q, h))) },
    // Recently deleted was a hub section, then the foot of the Devices board; it is the account's own page now.
    { pattern: `sandbox/deleted`, to: () => ({ link: page.deletedSandboxes(), frame: `home` }) },
    // The audit log was a hub section until 2026-10-17; its records are a part of Activity now, and how they are kept
    // (its old second part, `?section=keeping`) is Retention's.
    {
        pattern: `sandbox/audit`,
        to: (_p, q, h) =>
            q[`section`] === `keeping`
                ? inside(page.sandboxSettings(`retention`))
                : inside(page.sandboxSettings(`activity`, { query: { ...q, section: `audit` }, hash: h })),
    },
    // Areas was a hub section until 2026-10-26; it is a part of Access now, beside the profiles that name it.
    { pattern: `sandbox/areas`, to: (_p, q, h) => inside(page.sandboxSettings(`access`, { query: { ...q, section: `areas` }, hash: h })) },
    { pattern: `sandbox/:tab?`, to: (p, q, h) => inside(page.sandboxSettings(p[`tab`], extras(q, h))) },
    { pattern: `settings/:tab?`, to: (p, q, h) => ({ link: page.account(p[`tab`], extras(q, h)), frame: `home` }) },
    { pattern: `deleted-sandboxes`, to: (_p, q, h) => ({ link: page.deletedSandboxes(extras(q, h)), frame: `home` }) },
];

/** The patterns of every old address, for a router to route them to `legacyTarget`. */
export const LEGACY_PATTERNS: readonly string[] = LEGACY_ROUTES.map((route) => route.pattern);

const queryOf = (search: string): Query => Object.fromEntries(new URLSearchParams(search));

/**
 * What an old address (path, query and hash, as `fullPath` spells it) meant, or undefined when it is not one. The
 * `sandbox` key names the sandbox it was for and is the reader's to read, so it is left out of the page's query.
 */
export const legacyTarget = (fullPath: string): LegacyTarget | undefined => {
    const hashAt = fullPath.indexOf(`#`);
    const beforeHash = hashAt === -1 ? fullPath : fullPath.slice(0, hashAt);
    const hash = hashAt === -1 ? `` : fullPath.slice(hashAt + 1);
    const queryAt = beforeHash.indexOf(`?`);
    const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
    const query = withoutKey(queryAt === -1 ? {} : queryOf(beforeHash.slice(queryAt + 1)), `sandbox`);
    for (const route of LEGACY_ROUTES) {
        const params = matchPattern(route.pattern, path);
        if (params !== undefined) {
            return route.to(params, query, hash);
        }
    }
    return undefined;
};

/** The sandbox an old address named (`?sandbox=<id>`), if it named one. */
export const legacySandbox = (fullPath: string): string | undefined => {
    const search = fullPath.split(`#`, 1)[0]?.split(`?`)[1];
    const named = search === undefined ? null : new URLSearchParams(search).get(`sandbox`);
    return named === null || named === `` ? undefined : named;
};

// Each page's address before frames, for the readers that still read that form.
const OLD_PATTERNS = {
    chat: `chat`,
    agents: `agents`,
    agent: `agents/:id`,
    agentPage: `agents/:id/pages/:page`,
    workspace: `workspace/:path(.*)*`,
    browsers: `browsers/:tab(.*)?`,
    devices: `devices`,
    capabilities: `capabilities/:entry?`,
    extension: `ext/:ext/:key?`,
    sandboxSettings: `sandbox/:tab?`,
    terminal: `terminal`,
    menu: `menu`,
    account: `settings/:tab?`,
    deletedSandboxes: `deleted-sandboxes`,
} as const satisfies Readonly<Record<PageName, string>>;

/**
 * A link in the form addresses had before frames, the sandbox named as `?sandbox=`: what the Android app's bridge reads
 * (it parses `/agents/<id>` to open a conversation natively), so an installed app keeps working against this editor.
 */
export const legacyPathOf = (link: PageLink, sandbox?: string): string => {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(link.query)) {
        if (value !== undefined && value !== ``) {
            query[key] = value;
        }
    }
    if (sandbox !== undefined) {
        query[`sandbox`] = sandbox;
    }
    const search = Object.keys(query).length === 0 ? `` : `?${new URLSearchParams(query).toString()}`;
    return `/${fillPattern(OLD_PATTERNS[link.page], link.params)}${search}${link.hash === `` ? `` : `#${link.hash}`}`;
};
