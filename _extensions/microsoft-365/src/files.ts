import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Http } from "./auth.js";
import { type Graph, segment } from "./graph.js";

// Moving bytes between Microsoft and the workspace, so `fileq` and the agent's other tools can read what arrived. The
// backend that holds the card's sign-in never touches the workspace: the `m365` command reads the files a command names
// and hands their bytes over, and writes what comes back (CommandIo). Both directions stay inside the workspace,
// symlinks included, and nothing that arrives ever overwrites a file already there.

// What a command reads and writes, by the workspace path the agent named. In the backend: the files the CLI sent, and
// what it will save once the answer is back. Paths are the agent's own words, resolved inside the workspace by the CLI.
export interface CommandIo {
    // A file the command reads (`--file`, `--attach`, an upload's bytes).
    readonly read: (path: string) => Promise<Buffer>;
    // Bytes the command saves (a message's attachments); answers the path it was saved under.
    readonly write: (path: string, bytes: Uint8Array) => Promise<string>;
    // A file Microsoft serves from its own storage at a pre-authenticated address, fetched by the CLI without the card's
    // sign-in; answers the path it was saved under.
    readonly download: (path: string, url: string) => Promise<string>;
}

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
export const saveAttachments = async (graph: Graph, io: CommandIo, messageId: string, directory: string): Promise<string[]> => {
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
        saved.push(await io.write(`${directory}/${prefix}-${safe}`, bytes));
    }
    return saved;
};

const STORAGE_SUFFIXES = [".sharepoint.com", ".sharepoint.us", ".sharepoint.cn", ".1drv.com", ".storage.live.com"];

// Graph answers a file with a short-lived pre-authenticated address on Microsoft's own storage. Only such an address is
// ever fetched, and without the card's sign-in: the credential still goes only to sign-in and Graph.
export const storageUrl = (raw: string): URL => {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !STORAGE_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))) {
        throw new Error("Unsupported Microsoft storage download host");
    }
    return url;
};

// The item's download address, checked, handed to the CLI to fetch: the bytes never pass through the backend.
export const downloadFile = async (graph: Graph, io: CommandIo, path: string, output: string): Promise<string> => {
    const item = await graph.call<{ "@microsoft.graph.downloadUrl"?: string }>(path);
    const raw = item["@microsoft.graph.downloadUrl"];
    if (!raw) {
        throw new Error("This item has no downloadable content");
    }
    return io.download(output, storageUrl(raw).toString());
};

// The CLI's half of a download: the address checked again, fetched without credentials or redirects, saved.
export const fetchDownload = async (root: string, output: string, raw: string, http: Http = fetch): Promise<string> => {
    const response = await http(storageUrl(raw).toString(), { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`Microsoft file download failed (${response.status})`);
    }
    return saveBytes(root, output, new Uint8Array(await response.arrayBuffer()));
};
