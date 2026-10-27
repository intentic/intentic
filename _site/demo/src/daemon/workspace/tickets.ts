import { refuse } from "@intentic/contract-serve";
import { workspaceEntries } from "../../fixture/workspace";
import { bytesOf } from "./bytes";

// The tickets that stand in for a bearer where a browser cannot send one, as the daemon mints them
// (workspace-tickets.routes.ts): a media file's range reads, a selection's ZIP, a web page a frame loads with
// everything beside it. Each is bound to what was resolved when it was minted and checked again when it is spent, so a
// ticket for one file never buys another.

// A media ticket lives a sitting, a download's a few minutes, a page's as long as a media ticket (an hour with unsaved
// text in it), the daemon's own lifetimes.
const MEDIA_TTL_MS = 8 * 60 * 60 * 1000;
const DOWNLOAD_TTL_MS = 5 * 60 * 1000;
const PREVIEW_TTL_MS = 8 * 60 * 60 * 1000;
const UNSAVED_TTL_MS = 60 * 60 * 1000;

export interface DownloadPlan {
    // Each kept path with the name it takes in the archive.
    readonly names: ReadonlyMap<string, string>;
    readonly filename: string;
}

export interface PreviewPlan {
    // The folder addresses under the ticket name files in: the page's repository, else the workspace's root ("").
    readonly root: string;
    // The page, as a workspace path.
    readonly entry: string;
    // The page's unsaved text, served in place of the file.
    readonly source?: string;
}

type Binding = { readonly kind: `media`; readonly path: string } | { readonly kind: `download`; readonly plan: DownloadPlan } | { readonly kind: `preview`; readonly plan: PreviewPlan };

const held = new Map<string, { readonly binding: Binding; readonly expiresAt: number }>();

const mint = (binding: Binding, ttl: number) => {
    const ticket = `mt_${crypto.randomUUID().replaceAll(`-`, ``)}`;
    const expiresAt = Date.now() + ttl;
    held.set(ticket, { binding, expiresAt });
    return { ticket, expiresAt };
};

const bound = (ticket: string): Binding | undefined => {
    const found = held.get(ticket);
    if (found === undefined || found.expiresAt < Date.now()) {
        held.delete(ticket);
        return undefined;
    }
    return found.binding;
};

const clean = (path: string): string => path.replace(/^\/+|\/+$/gu, ``);

const isFolder = (path: string): boolean => [...workspaceEntries().keys()].some((entry) => entry.startsWith(`${path}/`));

/** Whether anything is at `path`: a file, or a folder with files in it. */
const pathExists = (path: string): boolean => workspaceEntries().has(path) || bytesOf(path) !== undefined || isFolder(path);

/** workspace.mediaTicket: refused for a file that is not there, as the daemon refuses it before playback starts. */
export const mintMediaTicket = (path: string) => {
    const target = clean(path);
    if (!workspaceEntries().has(target) && bytesOf(target) === undefined) {
        refuse(`not found`, 404);
    }
    return mint({ kind: `media`, path: target }, MEDIA_TTL_MS);
};

/** Whether `ticket` buys the file at `path`. */
export const mediaTicketCovers = (ticket: string, path: string): boolean => {
    const binding = bound(ticket);
    return binding?.kind === `media` && binding.path === clean(path);
};

// The deepest folder every kept path sits in, as segments.
const commonParent = (paths: readonly string[]): string[] => {
    const split = paths.map((path) => path.split(`/`).slice(0, -1));
    const first = split[0] ?? [];
    let depth = 0;
    while (depth < first.length && split.every((segments) => segments[depth] === first[depth])) {
        depth += 1;
    }
    return first.slice(0, depth);
};

// The daemon's nameSelection: a path inside another selected one goes with it; names are taken below the common
// parent; one entry is saved as `<name>.zip`, several as `<parent> (<n> items).zip`.
const nameSelection = (paths: readonly string[]): DownloadPlan => {
    const unique = [...new Set(paths.map(clean).filter((path) => path !== ``))];
    const kept = unique.filter((path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)));
    const parent = commonParent(kept);
    const names = new Map(kept.map((path) => [path, path.split(`/`).slice(parent.length).join(`/`)]));
    const only = kept.length === 1 ? kept[0] : undefined;
    const base = only === undefined ? (parent.at(-1) ?? `workspace`) : (only.split(`/`).at(-1) ?? `workspace`);
    return { names, filename: only === undefined ? `${base} (${kept.length} items).zip` : `${base}.zip` };
};

/** workspace.downloadTicket: every path checked now, so a missing one is refused before the browser starts a download. */
export const mintDownloadTicket = (paths: readonly string[]) => {
    const plan = nameSelection(paths);
    for (const path of plan.names.keys()) {
        if (!pathExists(path)) {
            refuse(`${path} is not there any more`, 404);
        }
    }
    return { ...mint({ kind: `download`, plan }, DOWNLOAD_TTL_MS), filename: plan.filename };
};

export const downloadPlanOf = (ticket: string): DownloadPlan | undefined => {
    const binding = bound(ticket);
    return binding?.kind === `download` ? binding.plan : undefined;
};

export const PREVIEW_PATH = `/workspace/preview/`;

// A path's segments, each escaped once, so a space or a `#` in a name stays part of it.
const encodePath = (path: string): string => path.split(`/`).map(encodeURIComponent).join(`/`);

/** workspace.previewTicket: the page's repository is what the ticket serves, the daemon's `repositoryOf`. */
export const mintPreviewTicket = (path: string, source: string | undefined) => {
    const entry = clean(path);
    if (source === undefined && !pathExists(entry)) {
        refuse(`not found`, 404);
    }
    const root = entry.includes(`/`) ? (entry.split(`/`)[0] ?? ``) : ``;
    const plan: PreviewPlan = source === undefined ? { root, entry } : { root, entry, source };
    const { ticket, expiresAt } = mint({ kind: `preview`, plan }, source === undefined ? PREVIEW_TTL_MS : UNSAVED_TTL_MS);
    return { page: `${PREVIEW_PATH}${ticket}/${encodePath(root === `` ? entry : entry.slice(root.length + 1))}`, root, expiresAt };
};

export const previewPlanOf = (ticket: string): PreviewPlan | undefined => {
    const binding = bound(ticket);
    return binding?.kind === `preview` ? binding.plan : undefined;
};
