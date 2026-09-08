import { cp, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SharePayload } from "@intentic/sandbox-contract";
import { SHARE_DIR, SHARE_VIEWER_DIR } from "@intentic/sandbox-contract/share-paths";
import { publicRoot } from "../public/public-files.js";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";
import { sharePage } from "./share-page.js";
import type { SharePicture } from "./share-payload.js";

// Writes a share into the outbox, the only disk-touching part of sharing. Maintains two things: one shared copy of the
// page's built assets, and a directory per share holding its own page and pictures (tree in share-paths.ts). Assets
// resolve through the package's own export, so this works the same from a dev checkout or the pruned production image.

// Resolves through the package's own export so this works the same in a dev checkout and the pruned production image.
// Called at share time, not boot: a missing bundle fails the first share rather than the whole daemon.
export const viewerDist = (): string => dirname(fileURLToPath(import.meta.resolve("@intentic/share-view/page")));

// Per-picture cap: generous for a screenshot, low enough a huge `Read` result can't become a download mirror.
const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

export const shareRoot = (workspaceRoot: string): string => join(publicRoot(workspaceRoot), SHARE_DIR);
const shareDir = (workspaceRoot: string, id: string): string => join(shareRoot(workspaceRoot), id);

// Copies the viewer's assets once, refreshing only when the daemon carries newer ones (an image upgrade). Compared by
// modification time rather than copied every share, since the built tree runs to hundreds of files.
const ensureViewer = async (workspaceRoot: string, source: string): Promise<void> => {
    const target = join(shareRoot(workspaceRoot), SHARE_VIEWER_DIR);
    const [from, to] = await Promise.all([stat(join(source, "index.html")), stat(join(target, "index.html")).catch(() => undefined)]);
    if (to !== undefined && to.mtimeMs >= from.mtimeMs) {
        return;
    }
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, force: true });
};

// Copies pictures out of the workspace, never links: a linked path would ask a recipient's browser for a file only this
// machine can reach. Anything that can't be copied is skipped, not failed; the card then draws the picture's path as
// text.
const copyPictures = async (workspaceRoot: string, dir: string, pictures: readonly SharePicture[]): Promise<void> => {
    for (const picture of pictures) {
        // Agent-chosen path, resolved against the workspace root and refused if it lands outside, like any other.
        const source = resolveWithin(workspaceRoot, picture.source);
        if (source === undefined) {
            continue;
        }
        const info = await stat(source).catch(() => undefined);
        if (info === undefined || !info.isFile() || info.size > MAX_PICTURE_BYTES) {
            continue;
        }
        const target = join(dir, picture.published);
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { force: true });
    }
};

// Writes one share whole; an update is the same write over the same id, with the directory cleared first so a picture
// no longer in the conversation doesn't linger.
export const publishShare = async (
    workspaceRoot: string,
    // Built page directory (`viewerDist()` in the daemon); a parameter so this is testable against a fixture.
    viewer: string,
    id: string,
    payload: SharePayload,
    pictures: readonly SharePicture[],
): Promise<void> => {
    const template = await readFile(join(viewer, "index.html"), "utf8");
    // Built before anything is written, so a template this daemon can't fill leaves the previous share untouched.
    const page = sharePage(template, payload);
    await ensureViewer(workspaceRoot, viewer);
    const dir = shareDir(workspaceRoot, id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await copyPictures(workspaceRoot, dir, pictures);
    await writeFile(join(dir, "index.html"), page);
};

// Removes the share directory whole (page and pictures together), then unwinds emptiness upward: the viewer assets go
// once no share needs them, and an outbox with nothing left stops existing. Failures here are swallowed; the share is
// gone either way.
export const unpublishShare = async (workspaceRoot: string, id: string): Promise<void> => {
    await rm(shareDir(workspaceRoot, id), { recursive: true, force: true });
    const root = shareRoot(workspaceRoot);
    const remaining = await readdir(root).catch(() => [SHARE_VIEWER_DIR, "keep"]);
    if (remaining.every((entry) => entry === SHARE_VIEWER_DIR)) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
        const outbox = publicRoot(workspaceRoot);
        const left = await readdir(outbox).catch(() => ["keep"]);
        if (left.length === 0) {
            await rmdir(outbox).catch(() => undefined);
        }
    }
};
