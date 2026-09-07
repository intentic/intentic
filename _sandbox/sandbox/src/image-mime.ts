/* WHAT MIME TYPE A RASTER ATTACHMENT RIDES AS, for the runtimes that can carry one natively.
 *
 * Three adapters attach images to a prompt — acp (ACP content blocks), grok (base64 data URLs, because the
 * OpenCode server is reached over HTTP and need not share this process's filesystem) and pi (Pi ImageContent) —
 * and each carried this table. Three copies is three places to add a format to, and two of them will be missed:
 * the extension set is a fact about image files, not a decision any one adapter makes.
 *
 * Deliberately NOT the same object as the two other mime tables in the daemon, which answer different
 * questions: `workspace/files/workspace-files-download.ts` keys without the dot and covers every file kind a
 * browser may download, and `public/public-files.ts` carries an `inline` disposition alongside the type. Those
 * are three questions that happen to share five rows, and folding them together would make each caller's table
 * grow the others' rows.
 *
 * A leaf at the root of src/ rather than under runtimes/, which is a shelf of independent adapters and holds no
 * code of its own (runtimes/invariant.ts says so). */
export const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};
