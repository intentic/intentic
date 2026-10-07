import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Page, PAGE_MAX_HEIGHT, PAGE_MIN_HEIGHT, PAGE_TITLE_MAX, standalonePage } from "@intentic/sandbox-contract";
import { statePath, stateRelPath } from "../../state-paths.js";

// Where the pages a conversation showed are kept: one folder per conversation under the workspace's records, one file
// per drawing. A page is never rewritten once shown, so a transcript reopened next month draws exactly what was seen;
// a redraw is a new file beside the old, and the conversation's folder goes with the conversation (conversation-purge.ts).

const PAGES = (...tail: readonly string[]): string => stateRelPath(".intentic/records/artifacts/", "pages", ...tail);

// The folder a conversation's pages are filed in; a turn with no conversation files its pages together.
const folderOf = (conversationId: string | undefined): string => (conversationId === undefined ? "loose" : conversationId.replace(/[^A-Za-z0-9_-]/g, "_"));

// Every conversation's pages, for the purge that removes one.
export const pagesFolder = (workspaceRoot: string, conversationId: string): string =>
    statePath(workspaceRoot, ".intentic/records/artifacts/", "pages", folderOf(conversationId));

const newId = (): string => randomBytes(5).toString("hex");

const FILE = /^([a-f0-9]{10})\.r(\d+)\.html$/;

// The latest drawing number of a page already filed in this conversation, or undefined when it holds no such page.
const latestRevision = async (folder: string, id: string): Promise<number | undefined> => {
    const names = await readdir(folder).catch(() => [] as string[]);
    let latest: number | undefined;
    for (const name of names) {
        const match = FILE.exec(name);
        if (match?.[1] === id) {
            latest = Math.max(latest ?? 0, Number(match[2]));
        }
    }
    return latest;
};

export class PageNotFoundError extends Error {
    constructor(readonly id: string) {
        super(`There is no page "${id}" in this conversation to redraw. Call show_page without \`replaces\` to show a new one.`);
    }
}

export interface PublishPageInput {
    readonly workspaceRoot: string;
    readonly conversationId: string | undefined;
    readonly title: string;
    // The page as it will be drawn, everything it names already carried inside it (page-assets.ts).
    readonly html: string;
    readonly height?: number | undefined;
    readonly measured?: number | undefined;
    readonly source?: string | undefined;
    // The id of a page this conversation already showed, to draw again in its place.
    readonly replaces?: string | undefined;
}

const clampHeight = (height: number): number => Math.min(PAGE_MAX_HEIGHT, Math.max(PAGE_MIN_HEIGHT, Math.round(height)));

// Files the page and answers with the row's description of it.
export const publishPage = async (input: PublishPageInput): Promise<Page> => {
    const folder = folderOf(input.conversationId);
    const absolute = join(input.workspaceRoot, PAGES(folder));
    await mkdir(absolute, { recursive: true });
    let id = newId();
    let revision = 0;
    if (input.replaces !== undefined) {
        const latest = await latestRevision(absolute, input.replaces);
        if (latest === undefined) {
            throw new PageNotFoundError(input.replaces);
        }
        id = input.replaces;
        revision = latest + 1;
    }
    const name = `${id}.r${revision}.html`;
    // Whole on its own as well (the outbox, a download): defaults the chat's own theme overrides wherever it draws it.
    await writeFile(join(absolute, name), standalonePage(input.html), "utf8");
    const title = input.title.trim().slice(0, PAGE_TITLE_MAX) || "Page";
    return {
        id,
        title,
        path: PAGES(folder, name),
        ...(input.height === undefined ? {} : { height: clampHeight(input.height) }),
        ...(input.measured === undefined || input.measured <= 0 ? {} : { measured: Math.round(input.measured) }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(revision === 0 ? {} : { revision }),
    };
};

// Removes a conversation's pages with it.
export const purgePages = (workspaceRoot: string, conversationId: string): Promise<void> =>
    rm(pagesFolder(workspaceRoot, conversationId), { recursive: true, force: true });
