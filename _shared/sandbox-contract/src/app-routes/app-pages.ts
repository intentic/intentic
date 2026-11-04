// THE APP'S PAGES, NAMED ONCE (2026-11-04). Every address the editor answers is spelled in this file and nowhere else:
// the editor's router builds its route table from it, and every link (the editor's own, an extension's, the daemon's
// push messages, the desktop and phone apps' hand-offs) is made by a constructor below, so a page renamed or moved is
// one edit here and a type error everywhere a link no longer fits. `_tools/checks/route-literals.mjs` fails an address
// typed by hand anywhere else, reading the patterns below to know what counts as one.
//
// A page of a sandbox is shown in one of two frames (paths.ts): inside the sandbox, `/s/<sandbox>/<page>`, or in Home's,
// `/home/<sandbox>/<page>`, where the rail lists every sandbox. Its pattern is the same in both. A page of the
// account's own (its settings, its deleted sandboxes) is shown in either frame too, and names no sandbox in Home's.

/** The pages of one sandbox, by name: the pattern of each below the frame's `/s/<sandbox>` or `/home/<sandbox>`. */
export const SANDBOX_PAGES = {
    /** The chat surface, expanded to the whole view; on a phone, the open conversation's own screen. */
    chat: `chat`,
    /** The board of every agent. */
    agents: `agents`,
    /** One agent: its conversation and its changes. */
    agent: `agents/:id`,
    /** One page an agent showed in its conversation, alone on the screen. */
    agentPage: `agents/:id/pages/:page`,
    /** The file tree and the open file, whose path is the rest of the address. */
    workspace: `workspace/:path(.*)*`,
    /** Everything live the sandbox shows (its browser windows, its apps, its desktop), the tab in front named. */
    browsers: `browsers/:tab(.*)?`,
    /** The machines the sandbox reaches. */
    devices: `devices`,
    /** The catalog of what the sandbox can connect to, one entry open. */
    capabilities: `capabilities/:entry?`,
    /** An extension's own view, one of its activations named. */
    extension: `ext/:ext/:key?`,
    /** The sandbox's own settings, one section open. */
    sandboxSettings: `settings/:tab?`,
    /** The terminal as a page: a phone's. */
    terminal: `terminal`,
    /** The rail's contents as a page: a phone's. */
    menu: `menu`,
} as const;

/** The account's own pages, shown in whichever frame the reader opened them from. */
export const ACCOUNT_PAGES = {
    /** The account's settings, one section open. */
    account: `account/:tab?`,
    /** The sandboxes the account deleted, still restorable. */
    deletedSandboxes: `deleted-sandboxes`,
} as const;

export type SandboxPageName = keyof typeof SANDBOX_PAGES;
export type AccountPageName = keyof typeof ACCOUNT_PAGES;
export type PageName = SandboxPageName | AccountPageName;

export const PAGE_PATTERNS = { ...SANDBOX_PAGES, ...ACCOUNT_PAGES } as const;

export const isSandboxPage = (name: PageName): name is SandboxPageName => Object.hasOwn(SANDBOX_PAGES, name);

/** A query as a link carries it: a key left undefined or empty is not written. */
export type LinkQuery = Readonly<Record<string, string | undefined>>;

/** What a link adds after the page: its query and the anchor it scrolls to (without `#`). */
export interface LinkExtras {
    readonly query?: LinkQuery | undefined;
    readonly hash?: string | undefined;
}

/**
 * A page and the values that pick what it shows: what a link names, before a frame says where it is drawn. Made only by
 * the constructors in `page`, so its parameters are always the ones its pattern names. No query is `{}`, no anchor ``.
 */
export interface PageLink<Name extends PageName = PageName> {
    readonly page: Name;
    readonly params: Readonly<Record<string, string | undefined>>;
    readonly query: LinkQuery;
    /** The anchor it scrolls to, without its `#`. */
    readonly hash: string;
}

const link = <Name extends PageName>(name: Name, params: PageLink[`params`], extras: LinkExtras = {}): PageLink<Name> => ({
    page: name,
    params,
    query: extras.query ?? {},
    hash: (extras.hash ?? ``).replace(/^#/, ``),
});

/** The constructors of every link, one per page, each taking what its page's pattern needs. */
export const page = {
    chat: (extras?: LinkExtras) => link(`chat`, {}, extras),
    agents: (extras?: LinkExtras) => link(`agents`, {}, extras),
    agent: (id: string, extras?: LinkExtras) => link(`agent`, { id }, extras),
    agentPage: (id: string, pageId: string, extras?: LinkExtras) => link(`agentPage`, { id, page: pageId }, extras),
    /** A file or folder by its path in the workspace, or the workspace with nothing open. */
    workspace: (path?: string, extras?: LinkExtras) => link(`workspace`, { path }, extras),
    browsers: (tab?: string, extras?: LinkExtras) => link(`browsers`, { tab }, extras),
    devices: (extras?: LinkExtras) => link(`devices`, {}, extras),
    capabilities: (entry?: string, extras?: LinkExtras) => link(`capabilities`, { entry }, extras),
    extension: (ext: string, key?: string, extras?: LinkExtras) => link(`extension`, { ext, key }, extras),
    sandboxSettings: (tab?: string, extras?: LinkExtras) => link(`sandboxSettings`, { tab }, extras),
    terminal: (extras?: LinkExtras) => link(`terminal`, {}, extras),
    menu: (extras?: LinkExtras) => link(`menu`, {}, extras),
    account: (tab?: string, extras?: LinkExtras) => link(`account`, { tab }, extras),
    deletedSandboxes: (extras?: LinkExtras) => link(`deletedSandboxes`, {}, extras),
} as const;

/** The same link with other extras: its query merged over, its hash replaced when one is given. */
export const withExtras = <Name extends PageName>(base: PageLink<Name>, extras: LinkExtras): PageLink<Name> =>
    link(base.page, base.params, { query: { ...base.query, ...extras.query }, hash: extras.hash ?? base.hash });

/**
 * The pages that are no sandbox's: the way in (sign-in, setup, an invite), the recovery and outage screens, the pages
 * the desktop app hands over, and the design kit a dev build serves. Each a pattern from the root.
 */
export const TOP_PAGES = {
    root: ``,
    login: `login`,
    loginConfirm: `login/confirm`,
    setup: `setup`,
    startHosted: `start/hosted`,
    invite: `invite/:token`,
    recover: `recover`,
    open: `open`,
    previewPass: `preview-pass`,
    platformUnavailable: `platform-unavailable`,
    desktopAuth: `desktop-auth`,
    desktopAuthComplete: `desktop-auth/complete`,
    kit: `kit`,
    kitRepair: `kit/repair`,
} as const;

export type TopPageName = keyof typeof TOP_PAGES;

/** The panels a floating window holds, each a window of its own on one sandbox. */
export const FLOATING_PANELS = [`chat`, `terminal`, `browsers`] as const;
export type FloatingPanel = (typeof FLOATING_PANELS)[number];

/**
 * A desktop window on a folder of this computer (the desktop app's local face) has a shell of its own with pages of its
 * own, none of them a sandbox's: the folder's files, this computer's page and vault, the folder's way to a sandbox.
 */
export const LOCAL_PAGES = {
    files: `workspace/:path(.*)*`,
    device: `device`,
    passwords: `passwords`,
    repair: `repair`,
    sandboxSetup: `sandbox-setup`,
    newSandbox: `sandbox-new`,
    process: `process/:id`,
    account: `account/:tab?`,
} as const;

export type LocalPageName = keyof typeof LOCAL_PAGES;
