import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { bool, flag, positional, required, limit as readLimit } from "../cli/args.js";
import { type Command, type CommandContext, type CommandGroup, printJson } from "../cli/command.js";
import { bytes, clip, count, row, tally, when } from "../cli/format.js";
import { contentTypeOf } from "../google/mime.js";
import { call, callBytes, paginate } from "../google/request.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_TYPE = "application/vnd.google-apps.folder";

// Drive returns nothing but ids unless asked, and asking for `*` is a lot of JSON per file.
const FIELDS = "nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, parents, owners(emailAddress))";

interface DriveFile {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly size?: string;
    readonly modifiedTime?: string;
    readonly webViewLink?: string;
    readonly owners?: readonly { readonly emailAddress?: string }[];
}

/* DRIVE'S QUERY LANGUAGE IS NOT SOMETHING TO MAKE ANYONE LEARN. `name contains 'budget' and trashed = false`
 * is what it wants; "budget" is what gets typed. So a bare phrase becomes a full-text search over content and
 * names, and anything that already looks like a query is passed through untouched, which keeps the whole
 * language available to whoever does know it. */
const OPERATORS = /\b(contains|in parents|mimeType|trashed|modifiedTime|starred|sharedWithMe|owners|fullText)\b/;

export const driveQuery = (input: string): string => {
    const phrase = input.trim();
    if (OPERATORS.test(phrase)) {
        return phrase;
    }
    return `fullText contains '${phrase.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' and trashed = false`;
};

/* Exporting a Google-native file means naming the format, and the formats differ per kind, a Doc has no csv,
 * a Sheet has no docx. Getting that wrong answers with a 400 nobody can act on, so the mapping is explicit and
 * an unsupported pair is refused here, by name. */
const EXPORTS: Record<string, Record<string, string>> = {
    "application/vnd.google-apps.document": {
        md: "text/markdown",
        txt: "text/plain",
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        html: "text/html",
    },
    "application/vnd.google-apps.spreadsheet": {
        csv: "text/csv",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pdf: "application/pdf",
    },
    "application/vnd.google-apps.presentation": {
        pdf: "application/pdf",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        txt: "text/plain",
    },
};

const DEFAULT_EXPORT: Record<string, string> = {
    "application/vnd.google-apps.document": "md",
    "application/vnd.google-apps.spreadsheet": "csv",
    "application/vnd.google-apps.presentation": "pdf",
};

export const exportMimeFor = (nativeType: string, format: string | undefined): string => {
    const available = EXPORTS[nativeType];
    if (available === undefined) {
        throw new Error(`${nativeType} is a Google file this cannot export. Open it in Drive, or ask for its content through gw docs / gw sheets.`);
    }
    const chosen = format ?? DEFAULT_EXPORT[nativeType];
    const mime = chosen === undefined ? undefined : available[chosen];
    if (mime === undefined) {
        throw new Error(`Cannot export that as "${chosen}" — available: ${Object.keys(available).join(", ")}.`);
    }
    return mime;
};

const fileLine = (file: DriveFile): string =>
    row(
        file.id,
        when(file.modifiedTime),
        file.mimeType === FOLDER_TYPE ? "dir" : bytes(file.size === undefined ? undefined : Number(file.size)),
        clip(file.name, 60),
        file.mimeType.startsWith("application/vnd.google-apps.") ? file.mimeType.replace("application/vnd.google-apps.", "google-") : undefined,
    );

const listFiles = async (ctx: CommandContext, query: string, max: number): Promise<DriveFile[]> =>
    paginate<DriveFile>(
        ctx.session,
        {
            url: `${API}/files`,
            query: { q: query, fields: FIELDS, orderBy: "modifiedTime desc", supportsAllDrives: true, includeItemsFromAllDrives: true },
        },
        { itemsOf: (page) => page["files"] as DriveFile[] | undefined, limit: max, sizeKey: "pageSize", maxPageSize: 100 },
    );

const search: Command = {
    name: "search",
    summary: "Find files by words in them or in their name",
    usage: 'gw drive search "quarterly budget" [-n 25]     (a real Drive query is passed through as written)',
    run: async (ctx) => {
        const phrase = ctx.args.positional.slice(1).join(" ");
        if (phrase === "") {
            throw new Error("Say what to look for.");
        }
        const max = readLimit(ctx.args, 25, 200);
        const files = await listFiles(ctx, driveQuery(phrase), max);
        if (ctx.json) {
            printJson(ctx, files);
            return;
        }
        for (const file of files) {
            ctx.out(fileLine(file));
        }
        ctx.out(tally(files.length, max, "files"));
    },
};

const ls: Command = {
    name: "ls",
    summary: "What is in a folder",
    usage: "gw drive ls [folderId]     (no id = My Drive's root)",
    run: async (ctx) => {
        const folder = ctx.args.positional[1] ?? "root";
        const max = readLimit(ctx.args, 100, 500);
        const files = await listFiles(ctx, `'${folder}' in parents and trashed = false`, max);
        if (ctx.json) {
            printJson(ctx, files);
            return;
        }
        for (const file of files) {
            ctx.out(fileLine(file));
        }
        ctx.out(tally(files.length, max, "items"));
    },
};

const get: Command = {
    name: "get",
    summary: "Download a file, converting Google formats on the way out",
    usage: "gw drive get <fileId> [--out path] [--as md|txt|pdf|docx|html|csv|xlsx|pptx]",
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A file id");
        const file = await call<DriveFile>(ctx.session, {
            url: `${API}/files/${encodeURIComponent(id)}`,
            query: { fields: "id, name, mimeType, size", supportsAllDrives: true },
        });
        const native = file.mimeType.startsWith("application/vnd.google-apps.");
        const data = native
            ? await callBytes(ctx.session, {
                  url: `${API}/files/${encodeURIComponent(id)}/export`,
                  query: { mimeType: exportMimeFor(file.mimeType, flag(ctx.args, "as")) },
              })
            : await callBytes(ctx.session, { url: `${API}/files/${encodeURIComponent(id)}`, query: { alt: "media", supportsAllDrives: true } });
        const out = flag(ctx.args, "out");
        if (out === undefined) {
            // No path given: print it, which is what makes a text file usable without touching the disk.
            ctx.out(data.toString("utf8"));
            return;
        }
        await writeFile(out, data);
        ctx.out(`${out}  ${bytes(data.byteLength)}  (${file.name})`);
    },
};

const put: Command = {
    name: "put",
    summary: "Upload a file from the workspace",
    usage: "gw drive put <path> [--folder folderId] [--name shownAs]",
    writes: true,
    run: async (ctx) => {
        const path = positional(ctx.args, 1, "A file path");
        const data = await readFile(path);
        const name = flag(ctx.args, "name") ?? basename(path);
        const folder = flag(ctx.args, "folder");
        const boundary = `gw-${process.hrtime.bigint().toString(36)}`;
        const metadata = { name, ...(folder === undefined ? {} : { parents: [folder] }) };
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`, "utf8"),
            Buffer.from(`--${boundary}\r\nContent-Type: ${contentTypeOf(path)}\r\n\r\n`, "utf8"),
            data,
            Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
        ]);
        const created = await call<DriveFile>(ctx.session, {
            method: "POST",
            url: UPLOAD,
            query: { uploadType: "multipart", fields: "id, name, webViewLink", supportsAllDrives: true },
            raw: { contentType: `multipart/related; boundary=${boundary}`, data: body },
        });
        if (ctx.json) {
            printJson(ctx, created);
            return;
        }
        ctx.out(row(created.id, created.name, created.webViewLink ?? ""));
    },
};

const mkdir: Command = {
    name: "mkdir",
    summary: "Make a folder",
    usage: "gw drive mkdir <name> [--folder parentId]",
    writes: true,
    run: async (ctx) => {
        const parent = flag(ctx.args, "folder");
        const created = await call<DriveFile>(ctx.session, {
            method: "POST",
            url: `${API}/files`,
            query: { fields: "id, name, webViewLink", supportsAllDrives: true },
            body: { name: positional(ctx.args, 1, "A folder name"), mimeType: FOLDER_TYPE, ...(parent === undefined ? {} : { parents: [parent] }) },
        });
        ctx.out(row(created.id, created.name, created.webViewLink ?? ""));
    },
};

const mv: Command = {
    name: "mv",
    summary: "Move a file into another folder",
    usage: "gw drive mv <fileId> --folder <folderId>",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A file id");
        const folder = required(ctx.args, "folder");
        const current = await call<{ parents?: string[] }>(ctx.session, {
            url: `${API}/files/${encodeURIComponent(id)}`,
            query: { fields: "parents", supportsAllDrives: true },
        });
        const moved = await call<DriveFile>(ctx.session, {
            method: "PATCH",
            url: `${API}/files/${encodeURIComponent(id)}`,
            query: { addParents: folder, removeParents: (current.parents ?? []).join(","), fields: "id, name, parents", supportsAllDrives: true },
        });
        ctx.out(`${moved.id} moved into ${folder}`);
    },
};

const rm: Command = {
    name: "rm",
    summary: "Send a file to Drive's bin",
    usage: "gw drive rm <fileId>",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A file id");
        // Trashed, never deleted: Drive's own delete is permanent and immediate, and nothing an agent does on
        // someone's behalf should be unrecoverable. The owner empties the bin.
        await call(ctx.session, {
            method: "PATCH",
            url: `${API}/files/${encodeURIComponent(id)}`,
            query: { supportsAllDrives: true },
            body: { trashed: true },
        });
        ctx.out(`${id} moved to Drive's bin (restorable for 30 days)`);
    },
};

const share: Command = {
    name: "share",
    summary: "Give someone access",
    usage: "gw drive share <fileId> --email someone@x.com [--role reader|commenter|writer] [--notify]",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A file id");
        const email = required(ctx.args, "email");
        const role = flag(ctx.args, "role") ?? "reader";
        if (!["reader", "commenter", "writer"].includes(role)) {
            throw new Error(`--role must be reader, commenter or writer (not "${role}"). Ownership transfer is deliberately not offered here.`);
        }
        await call(ctx.session, {
            method: "POST",
            url: `${API}/files/${encodeURIComponent(id)}/permissions`,
            query: { sendNotificationEmail: bool(ctx.args, "notify"), supportsAllDrives: true },
            body: { type: "user", role, emailAddress: email },
        });
        ctx.out(`${email} can now ${role === "reader" ? "read" : role === "commenter" ? "comment on" : "edit"} ${id}`);
    },
};

const link: Command = {
    name: "link",
    summary: "The URL a person would open",
    usage: "gw drive link <fileId>",
    run: async (ctx) => {
        const file = await call<DriveFile>(ctx.session, {
            url: `${API}/files/${encodeURIComponent(positional(ctx.args, 1, "A file id"))}`,
            query: { fields: "id, name, webViewLink, owners(emailAddress)", supportsAllDrives: true },
        });
        ctx.out(row(file.webViewLink ?? "(no link)", file.name, file.owners?.[0]?.emailAddress ?? ""));
    },
};

const permissions: Command = {
    name: "who",
    summary: "Who can currently see a file",
    usage: "gw drive who <fileId>",
    run: async (ctx) => {
        const found = await call<{ permissions?: { id: string; type: string; role: string; emailAddress?: string }[] }>(ctx.session, {
            url: `${API}/files/${encodeURIComponent(positional(ctx.args, 1, "A file id"))}/permissions`,
            query: { fields: "permissions(id, type, role, emailAddress)", supportsAllDrives: true },
        });
        const listed = found.permissions ?? [];
        if (ctx.json) {
            printJson(ctx, listed);
            return;
        }
        for (const permission of listed) {
            ctx.out(row(permission.emailAddress ?? permission.type, permission.role));
        }
        ctx.out(count(listed.length, "people or groups"));
    },
};

export const driveGroup: CommandGroup = {
    name: "drive",
    summary: "Drive — find, read, upload, organise, share",
    commands: [search, ls, get, put, mkdir, mv, rm, share, link, permissions],
};
