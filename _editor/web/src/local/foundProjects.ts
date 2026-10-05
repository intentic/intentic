import type { LocalFoundProject, LocalFoundProvider, LocalPlace } from "../app/environments/localHost";

// WHAT AN EMPTY MAIN WINDOW OFFERS IN PLACE OF ITS EMPTINESS (LocalEmptyFolder.vue): the folders this app opened before,
// then the ones this computer's AI tools and editors worked in (the app's found.rs), one row per folder. Pure, so the
// merge and its words are testable without an app behind the page.

/** A folder offered to open, from either list. */
export interface OfferedProject {
    /** What `point` takes. */
    readonly path: string;
    /** How it reads: a distro's Linux path, otherwise `path`. */
    readonly shown: string;
    readonly name: string;
    /** This app opened it before. */
    readonly openedHere: boolean;
    /** The tools whose history named it, by their ids (`toolName` words them). */
    readonly sources: readonly string[];
    /** Epoch milliseconds of the newest use either list knows of. */
    readonly at: number | undefined;
    readonly wsl: string | undefined;
    readonly git: boolean;
    readonly sandbox: boolean;
}

/** How many folders the page offers: enough to find last week's, few enough to read at a glance. */
export const OFFERED = 8;

// Product names, which no language translates.
const TOOL_NAMES = new Map([
    [`claude-code`, `Claude Code`],
    [`codex`, `Codex`],
    [`gemini-cli`, `Gemini CLI`],
    [`opencode`, `opencode`],
    [`hermes`, `Hermes`],
    [`openclaw`, `OpenClaw`],
    [`vscode`, `VS Code`],
    [`cursor`, `Cursor`],
    [`vscodium`, `VSCodium`],
    [`windsurf`, `Windsurf`],
    [`jetbrains`, `JetBrains`],
]);

export const toolName = (id: string): string => TOOL_NAMES.get(id) ?? id;

/** The tools a list of ids names, in order, each once: "Claude Code, Codex". */
export const toolNames = (ids: readonly string[]): string => [...new Set(ids.map(toolName))].join(`, `);

// One spelling per folder: a Windows path is the same folder whatever its case or its slashes.
const keyOf = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/u, ``);
    return /^(?:[a-z]:[\\/]|\\\\)/iu.test(trimmed) ? trimmed.replaceAll(`/`, `\\`).toLowerCase() : trimmed;
};

const nameOf = (path: string): string => path.split(/[\\/]/u).findLast((segment) => segment !== ``) ?? path;

// `\\wsl.localhost\<distro>\…` and the older `\\wsl$\<distro>\…`: a folder of a distro, reached from Windows.
const wslOf = (path: string): string | undefined => /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/iu.exec(path)?.[1];

// The app keeps `openedAt` as Unix seconds, epoch milliseconds or an ISO instant (localHost.ts `LocalPlace`).
const epochMs = (openedAt: number | string): number | undefined => {
    const count = Number(openedAt);
    if (Number.isFinite(count)) {
        return count < 1e12 ? count * 1000 : count;
    }
    const parsed = Date.parse(String(openedAt));
    return Number.isNaN(parsed) ? undefined : parsed;
};

const newest = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined ? right : right === undefined ? left : Math.max(left, right);

/**
 * The folders to offer: this app's recents first, in their order, since a folder opened here is the surest sign of one
 * that matters; then the found ones, newest first as the app ranked them. One row per folder, the two lists' facts
 * joined. Never a folder the window shows now or the app's own starting folder (`skip`), a document, or a recent that
 * is gone.
 */
export const offeredProjects = (
    places: readonly LocalPlace[],
    found: readonly LocalFoundProject[],
    skip: readonly string[],
    limit = OFFERED,
): OfferedProject[] => {
    const skipped = new Set(skip.filter((path) => path !== ``).map(keyOf));
    const offered = new Map<string, OfferedProject>();
    for (const place of places) {
        const key = keyOf(place.path);
        if (!place.folder || !place.exists || skipped.has(key) || offered.has(key)) {
            continue;
        }
        offered.set(key, {
            path: place.path,
            shown: place.path,
            name: nameOf(place.path),
            openedHere: true,
            sources: [],
            at: epochMs(place.openedAt),
            wsl: wslOf(place.path),
            git: false,
            sandbox: place.sandbox,
        });
    }
    for (const project of found) {
        const key = keyOf(project.path);
        if (skipped.has(key)) {
            continue;
        }
        const at = project.lastActive === null ? undefined : project.lastActive * 1000;
        const here = offered.get(key);
        offered.set(
            key,
            here === undefined
                ? {
                      path: project.path,
                      shown: project.shown,
                      name: project.name,
                      openedHere: false,
                      sources: project.sources,
                      at,
                      wsl: project.wsl ?? undefined,
                      git: project.git,
                      sandbox: project.sandbox,
                  }
                : {
                      ...here,
                      shown: project.shown,
                      sources: project.sources,
                      at: newest(here.at, at),
                      wsl: here.wsl ?? project.wsl ?? undefined,
                      git: project.git,
                      sandbox: here.sandbox || project.sandbox,
                  },
        );
    }
    return [...offered.values()].slice(0, limit);
};

/** The sandbox providers found signed in here, in the order found, for a page that names them. */
export const foundSubscriptions = (providers: readonly LocalFoundProvider[]): readonly LocalFoundProvider[] =>
    providers.filter((provider, index) => providers.findIndex((other) => other.provider === provider.provider) === index);

// The subscriptions as people know them: by the product they signed in to, not the sandbox's provider id.
const SUBSCRIPTION_NAMES = new Map([
    [`claude`, `Claude`],
    [`codex`, `ChatGPT`],
    [`gemini`, `Google Gemini`],
    [`grok`, `Grok`],
    [`kimi`, `Kimi`],
    [`cursor`, `Cursor`],
]);

/** "Claude (Max)", "ChatGPT (Plus)": the subscription and its plan, as the tool recorded it. */
export const subscriptionName = (provider: LocalFoundProvider): string => {
    const name = SUBSCRIPTION_NAMES.get(provider.provider) ?? provider.provider;
    const plan = provider.plan?.trim();
    return plan === undefined || plan === `` ? name : `${name} (${plan.charAt(0).toUpperCase()}${plan.slice(1)})`;
};
