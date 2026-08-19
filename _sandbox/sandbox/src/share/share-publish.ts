import { cp, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SharePayload } from "@intentic/sandbox-contract";
import { SHARE_DIR, SHARE_VIEWER_DIR } from "@intentic/sandbox-contract/share-paths";
import { publicRoot } from "../public/public-files.js";
import { resolveWithin } from "../workspace/workspace-files.js";
import { sharePage } from "./share-page.js";
import type { SharePicture } from "./share-payload.js";

/* WRITING A SHARE INTO THE OUTBOX — the only part of sharing that touches the disk.
 *
 * The tree it maintains is described in the contract's share-paths.ts. Two halves: one copy of the page's
 * built assets that every share loads, and a directory per share holding its own page and its own pictures.
 *
 * The assets are resolved through the package's own export, so this works identically from a checkout in dev
 * and from the pruned production tree in the image — the same resolution the Front Desk widget's route uses,
 * for the same reason. */

/* Where the built page lives, resolved through the package's own export rather than by walking node_modules —
 * so it works identically from a checkout in dev and from the pruned production tree in the image, the same
 * resolution the Front Desk widget's route uses.
 *
 * Called at share time, never at boot: `import.meta.resolve` throws for a package that is not there, and a
 * daemon that refused to start because the page bundle is missing would trade one broken feature for a broken
 * sandbox. Missing, the first share fails with a message and everything else keeps working. */
export const viewerDist = (): string => dirname(fileURLToPath(import.meta.resolve("@intentic/share-view/page")));

// A single picture past this is not copied. Generous for a screenshot or a diagram, and low enough that a
// conversation which happened to `Read` a 300 MB texture does not turn a share into a download mirror.
const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

export const shareRoot = (workspaceRoot: string): string => join(publicRoot(workspaceRoot), SHARE_DIR);
const shareDir = (workspaceRoot: string, id: string): string => join(shareRoot(workspaceRoot), id);

/* The page's assets, copied in once and refreshed when the daemon carries newer ones — which happens exactly
 * when the sandbox image is upgraded, since the two ship together. Compared by modification time rather than
 * copied every share: the built tree is a hundred-odd files (one per syntax grammar), and re-copying them on
 * every Update would be the most expensive part of an operation that is otherwise writing one page. */
const ensureViewer = async (workspaceRoot: string, source: string): Promise<void> => {
    const target = join(shareRoot(workspaceRoot), SHARE_VIEWER_DIR);
    const [from, to] = await Promise.all([stat(join(source, "index.html")), stat(join(target, "index.html")).catch(() => undefined)]);
    if (to !== undefined && to.mtimeMs >= from.mtimeMs) {
        return;
    }
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, force: true });
};

/* The pictures a conversation showed, copied out of the workspace and next to the page.
 *
 * COPIED, not linked, and that is the whole point: the outbox refuses a symlink that leaves it (public-files.ts
 * rule 1), and a page that addressed `/work/...` would be asking a recipient's browser for a file no one outside
 * this machine can fetch. After this, nothing on the published side names a workspace path.
 *
 * Anything that cannot be copied is skipped rather than failing the share — the payload's own picture entries
 * are what the page draws, and a missing file there degrades to the card showing its path as text, which is
 * what an un-shareable picture honestly is. */
const copyPictures = async (workspaceRoot: string, dir: string, pictures: readonly SharePicture[]): Promise<void> => {
    for (const picture of pictures) {
        // The path came out of a transcript, which means an agent chose it — so it is resolved against the
        // workspace root and refused if it lands outside, exactly like any other path the daemon is handed.
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

/* One share, written whole. Used by both the first share and Update — an Update is the same write over the
 * same id, with the share's directory cleared first so a picture that has since left the conversation does not
 * linger next to a page that no longer shows it. */
export const publishShare = async (
    workspaceRoot: string,
    // The built page's directory — `viewerDist()` in the daemon. A parameter rather than a lookup inside,
    // because "where is the bundle" is the caller's question and this way the write is testable against a
    // fixture instead of against whatever the image happens to carry.
    viewer: string,
    id: string,
    payload: SharePayload,
    pictures: readonly SharePicture[],
): Promise<void> => {
    const template = await readFile(join(viewer, "index.html"), "utf8");
    // Built before anything is written, so a template this daemon cannot fill leaves the previous share of
    // that id exactly as it was rather than half-replaced.
    const page = sharePage(template, payload);
    await ensureViewer(workspaceRoot, viewer);
    const dir = shareDir(workspaceRoot, id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await copyPictures(workspaceRoot, dir, pictures);
    await writeFile(join(dir, "index.html"), page);
};

/* Stop sharing: the page and every picture beside it, gone in one removal — which is why a share is a
 * directory (share-paths.ts).
 *
 * Then the two levels of emptiness above it, on the outbox's own rule that publishing is OFF when there is
 * nothing published: withdrawing the last share takes the assets with it (they exist only to serve shares),
 * and an outbox left with nothing at all stops existing. Failures here are not raised — the share itself is
 * gone either way, and an empty directory is corrected by the next removal. */
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
