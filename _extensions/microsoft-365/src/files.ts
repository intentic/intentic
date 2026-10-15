import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Http } from "./auth.js";
import { type Graph, segment } from "./graph.js";

// Moving bytes between Microsoft and the workspace, so `fileq` and the agent's other tools can read what arrived. Both
// directions stay inside the workspace, symlinks included, and nothing that arrives ever overwrites a file already
// there.

export const workspaceFile = async (root: string, name: string, writing: boolean): Promise<string> => {
    const base = await realpath(root);
    const target = resolve(base, name);
    const inside = (path: string): boolean => {
        const rel = relative(base, path);
        return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
    };
    if (!inside(target)) {
        throw new Error("File must be inside the workspace");
    }
    if (writing) {
        // Walk each directory so mkdir cannot create a directory through an escaping symlink.
        let parent = base;
        for (const part of relative(base, dirname(target)).split("/").filter(Boolean)) {
            parent = resolve(parent, part);
            await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") {
                    throw error;
                }
            });
            if (!inside(await realpath(parent))) {
                throw new Error("Directory symlink leaves the workspace");
            }
        }
    } else if (!inside(await realpath(target))) {
        throw new Error("File symlink leaves the workspace");
    }
    return target;
};
export const saveBytes = async (root: string, name: string, bytes: Uint8Array): Promise<string> => {
    const target = await workspaceFile(root, name, true);
    const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        await file.writeFile(bytes);
    } finally {
        await file.close();
    }
    return target;
};
interface Attachment {
    id: string;
    name?: string;
    size?: number;
    contentBytes?: string;
    "@odata.type"?: string;
}

// More than any real message carries; a hostile one cannot make this loop forever.
const ATTACHMENTS_MAX = 250;
export const saveAttachments = async (graph: Graph, root: string, messageId: string, directory: string): Promise<string[]> => {
    const path = `/me/messages/${segment(messageId)}/attachments`;
    const attachments = await graph.list<Attachment>(path, ATTACHMENTS_MAX);
    const saved: string[] = [];
    for (const item of attachments) {
        // A link to a file elsewhere (OneDrive, SharePoint) holds no bytes: it stays a link in the message.
        if (item["@odata.type"] === "#microsoft.graph.referenceAttachment") {
            continue;
        }
        const safe = basename(item.name ?? "attachment").replace(/[^\p{L}\p{N}_.-]/gu, "_") || "attachment";
        // Two attachments may share a name; the id's hash keeps them apart and a re-save from clobbering either.
        const prefix = createHash("sha256").update(item.id).digest("hex").slice(0, 20);
        const bytes =
            item.contentBytes !== undefined
                ? Buffer.from(item.contentBytes, "base64")
                : new Uint8Array(await (await graph.response(`${path}/${segment(item.id)}/$value`)).arrayBuffer());
        saved.push(await saveBytes(root, `${directory}/${prefix}-${safe}`, bytes));
    }
    return saved;
};

// Graph answers a file with a short-lived pre-authenticated storage URL. It is fetched without the bearer, only on
// Microsoft's own storage domains, and never printed: the card's credential still goes only to sign-in and Graph.
export const downloadFile = async (graph: Graph, root: string, path: string, output: string, http: Http = fetch): Promise<string> => {
    const item = await graph.call<{ "@microsoft.graph.downloadUrl"?: string }>(path);
    const raw = item["@microsoft.graph.downloadUrl"];
    if (!raw) {
        throw new Error("This item has no downloadable content");
    }
    const url = new URL(raw);
    const suffixes = [".sharepoint.com", ".sharepoint.us", ".sharepoint.cn", ".1drv.com", ".storage.live.com"];
    if (url.protocol !== "https:" || url.username || url.password || url.port || !suffixes.some((suffix) => url.hostname.endsWith(suffix))) {
        throw new Error("Unsupported Microsoft storage download host");
    }
    const response = await http(url.toString(), { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`Microsoft file download failed (${response.status})`);
    }
    return saveBytes(root, output, new Uint8Array(await response.arrayBuffer()));
};
