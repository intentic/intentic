import { readFile } from "node:fs/promises";
import type { CommandContext, Commands } from "./commands.js";
import { downloadFile, workspaceFile } from "./files.js";
import { type Json, query, segment } from "./graph.js";

// OneDrive and SharePoint document libraries, as the signed-in user sees them: their own site permissions decide what
// is reachable. Downloads land in the workspace for `fileq`; an upload puts a file where colleagues read it, so it is
// `microsoft365.files.upload` and waits for the owner unless a rule says otherwise.

const ITEM_FIELDS = "id,name,size,lastModifiedDateTime,lastModifiedBy,webUrl,folder,file,parentReference";
// Graph's simple upload takes up to 4 MiB in one request; anything larger needs an upload session.
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const PAGE_MAX = 200;

const driveOf = (ctx: CommandContext): string => {
    const drive = ctx.flag("drive");
    return drive === undefined ? "/me/drive" : `/drives/${segment(drive)}`;
};

const upload = async (ctx: CommandContext): Promise<Json | undefined> => {
    const name = ctx.required("name");
    if (/[/\\]/.test(name) || name === "." || name === "..") {
        throw new Error("--name is the file's name in the library, without folders: pick the folder with --parent");
    }
    const source = ctx.required("file");
    const bytes = await readFile(await workspaceFile(ctx.root, source, false));
    if (bytes.length > UPLOAD_MAX_BYTES) {
        throw new Error("This CLI uploads files up to 4 MiB; a larger one needs an upload session, which it does not do yet");
    }
    const parent = ctx.flag("parent");
    const where = parent === undefined ? "root" : `items/${segment(parent)}`;
    const drive = ctx.flag("drive") ?? "the signed-in user's OneDrive";
    return ctx.act({
        key: "microsoft365.files.upload",
        path: `${driveOf(ctx)}/${where}:/${segment(name)}:/content`,
        method: "PUT",
        body: bytes.toString("base64"),
        binary: true,
        summary: `Upload ${name} (${Math.max(1, Math.round(bytes.length / 1024))} KB) to ${parent === undefined ? "the top" : "a folder"} of ${drive}`,
        details: [
            `Upload the workspace file ${source} as "${name}".`,
            `Library: ${drive}; folder: ${parent ?? "the library's top level"}.`,
            "A file of the same name there is replaced (its earlier version stays in the library's version history).",
            `Size: ${bytes.length} bytes. The bytes are frozen with this request; edits to the workspace file after proposing are not sent.`,
        ].join("\n"),
    });
};

export const documentCommands: Commands = {
    drives: async (ctx) => ctx.graph.list<Json>("/me/drives?$select=id,name,driveType,webUrl,owner", 200),
    sites: async (ctx) => ctx.graph.list<Json>(`/sites?${query({ search: ctx.required("query"), $select: "id,displayName,webUrl" })}`, 50),
    libraries: async (ctx) => ctx.graph.list<Json>(`/sites/${segment(ctx.id())}/drives?$select=id,name,driveType,webUrl`, 200),
    list: async (ctx) => {
        const limit = ctx.limit(200);
        const item = ctx.flag("item");
        const folder = item === undefined ? "root" : `items/${segment(item)}`;
        return ctx.graph.list<Json>(
            `${driveOf(ctx)}/${folder}/children?${query({ $select: ITEM_FIELDS, $top: String(Math.min(limit, PAGE_MAX)) })}`,
            limit,
        );
    },
    search: async (ctx) => {
        const limit = ctx.limit(50);
        const text = segment(ctx.required("query").replaceAll("'", "''"));
        return ctx.graph.list<Json>(
            `${driveOf(ctx)}/root/search(q='${text}')?${query({ $select: ITEM_FIELDS, $top: String(Math.min(limit, PAGE_MAX)) })}`,
            limit,
        );
    },
    download: async (ctx) => ({ saved: await downloadFile(ctx.graph, ctx.root, `${driveOf(ctx)}/items/${segment(ctx.id())}`, ctx.required("out")) }),
    upload,
};
