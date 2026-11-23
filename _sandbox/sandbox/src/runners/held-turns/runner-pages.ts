import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import {
    PAGE_MEDIA_REF,
    PAGE_MEDIA_REFS,
    type PageMediaFile,
    pageMediaScript,
    readPageMedia,
    withoutPageMedia,
} from "@intentic/sandbox-contract/text/pages";
import { pageMediaKeyPath, signPageMedia } from "../../workspace/files/stored/stored-page-media.js";
import { ARTIFACTS_DIR, artifactFile } from "../../workspace/files/stored/stored-artifacts.js";
import { keepPageCopy, PAGES_DIR, readStoredPage } from "../../workspace/files/stored/stored-pages.js";
import type { RunnerClient } from "../runner-peer.js";
import { type ArtifactsHomeContext, askOptions, fetchHome } from "./runner-artifacts.js";

/* THE PAGES A RUNNER'S TURN SHOWED, BROUGHT HOME. `show_page` files the page in the workspace of the machine running the
   turn (page-store.ts), and its frame names that path; the chat reads every page from this sandbox's workspace, and
   neither the relay nor the branch's push carries a records file. So a runner's page read as "could not be loaded"
   (bird-mdu4 on omen, 2026-11-23). Each page frame now waits while its file is fetched from the runner and filed here at
   the same path, so the frame reaches the chat with the page already in place.
   Its video and audio come too (2026-11-23): the page's manifest names files by their real paths on the runner and is
   signed with the runner's key, so this sandbox would serve none of it. Each file is copied into the artifacts folder's
   runner/<conversation>/media/, and the manifest rewritten to the copies (real path, size and modification time, as
   page-media.routes.ts checks them) and signed with this sandbox's own key before the page is filed. */

const ASK_MS = 30_000;

export interface PagesHomeContext extends ArtifactsHomeContext {
    // Where this sandbox keeps the key it signs page manifests with (page-media.ts pageMediaKeyPath).
    readonly historyRoot: string;
}

// The `index`th media file of `page`, copied here: the manifest entry it earns, naming the copy; undefined when it could
// not be brought, since a path this sandbox did not write is never signed here.
const mediaFileHome = async (context: PagesHomeContext, client: RunnerClient, page: string, index: number, file: PageMediaFile): Promise<PageMediaFile | undefined> => {
    const folder = page.slice(PAGES_DIR.length).split("/")[0] ?? "loose";
    try {
        const fetched = await fetchHome(context, `${ARTIFACTS_DIR}runner/${folder}/media/${basename(file.path)}`, ({ offset, length }) =>
            client.readPageMedia({ page, index, offset, length }, askOptions()),
        );
        const real = fetched.kind === "filed" ? await artifactFile(context.workspaceRoot, fetched.path) : undefined;
        const info = real === undefined ? undefined : await stat(real);
        return real === undefined || info === undefined ? undefined : { path: real, type: file.type, size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
        context.logger.warn({ err: error, runner: context.runnerId, page, index }, "runner dispatch: a video or audio file of a page the runner showed could not be brought home");
        return undefined;
    }
};

// What a reference to a file that could not be brought becomes: no longer a reference, so the page shows it missing.
const UNAVAILABLE_REF = "intentic-media-unavailable:";

// The page's text as it is filed here: its media copied home, its references renumbered to the copies and its manifest
// re-signed for them with this sandbox's key. A file that could not be brought leaves the manifest, and its references
// stop naming any; with none brought, the page keeps no manifest at all.
const mediaHome = async (context: PagesHomeContext, client: RunnerClient, page: string, html: string): Promise<string> => {
    const manifest = readPageMedia(html);
    if (manifest === undefined) {
        return html;
    }
    const files: PageMediaFile[] = [];
    const renumbered = new Map<number, number>();
    for (const [index, file] of manifest.files.entries()) {
        const copy = await mediaFileHome(context, client, page, index, file);
        if (copy !== undefined) {
            renumbered.set(index, files.length);
            files.push(copy);
        }
    }
    const text = withoutPageMedia(html).replace(PAGE_MEDIA_REFS, (whole, index: string) => {
        const now = renumbered.get(Number(index));
        return now === undefined ? `${UNAVAILABLE_REF}${index}` : `${PAGE_MEDIA_REF}${now}`;
    });
    return files.length === 0 ? text : `${text}${pageMediaScript(await signPageMedia(pageMediaKeyPath(context.historyRoot), page, files))}`;
};

// The stored page a frame draws, when it draws one.
const pageOf = (event: AgentEvent): string | undefined => (event.kind === "page" || event.kind === "page_ask" ? event.page.path : undefined);

/** Files the page a frame draws before the frame goes on; a page that cannot be fetched is logged and the frame still goes. */
export const bringPageHome = async (context: PagesHomeContext, event: AgentEvent): Promise<void> => {
    const path = pageOf(event);
    const client = path === undefined ? undefined : context.hub.client(context.runnerId);
    if (path === undefined || client === undefined) {
        return;
    }
    try {
        // A stored page is never rewritten, so one already here (its frame relayed before) costs nothing more.
        if ((await readStoredPage(context.workspaceRoot, path)) !== undefined) {
            return;
        }
        const { html } = await client.readPage({ path }, { signal: AbortSignal.timeout(ASK_MS) });
        if (!(await keepPageCopy(context.workspaceRoot, path, await mediaHome(context, client, path, html)))) {
            context.logger.warn({ runner: context.runnerId, path }, "runner dispatch: a page frame named no stored page, so nothing was filed");
        }
    } catch (error) {
        context.logger.warn({ err: error, runner: context.runnerId, path }, "runner dispatch: a page the runner showed could not be brought home");
    }
};
