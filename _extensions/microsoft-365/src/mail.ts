import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CommandContext, Commands } from "./commands.js";
import { saveAttachments, workspaceFile } from "./files.js";
import { type Json, query, segment } from "./graph.js";

// Outlook mail. Reading is free; sending, replying and forwarding are `microsoft365.mail.send`, so they are proposed
// for the owner's approval unless a rule says otherwise. The approval shows the owner who it goes to, what it says and
// what is attached, in words rather than Graph's JSON.

const LIST_FIELDS = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,importance,bodyPreview,conversationId";
// One Graph request carries every attachment of a send, and Graph refuses a request over 4 MB once base64 has grown it.
const ATTACH_MAX_BYTES = 3 * 1024 * 1024;
const PAGE_MAX = 100;

interface Recipient {
    readonly emailAddress?: { readonly address?: string; readonly name?: string };
}

interface Message {
    readonly subject?: string;
    readonly body?: { readonly contentType?: string; readonly content?: string };
    readonly from?: Recipient;
    readonly toRecipients?: readonly Recipient[];
    readonly ccRecipients?: readonly Recipient[];
    readonly bccRecipients?: readonly Recipient[];
    readonly attachments?: readonly Json[];
    // A reply's or forward's request: its text, and the message properties it overrides (recipients, body).
    readonly comment?: string;
    readonly message?: Message;
}

const addresses = (list: readonly Recipient[] | undefined): string =>
    (list ?? [])
        .map((recipient) => recipient.emailAddress?.address ?? "")
        .filter((address) => address !== "")
        .join(", ") || "nobody";

const kilobytes = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

// The agent's request file, which must at least be one JSON object.
const messageFile = async (ctx: CommandContext): Promise<Message> => {
    const value = await ctx.json();
    if (value === null || Array.isArray(value) || Object(value) !== value) {
        throw new Error("--file must hold one JSON object (a Graph message)");
    }
    // SAFETY: an object, checked above; every field read from it is optional and Graph validates the rest.
    return value as Message;
};

interface Attached {
    readonly attachments: readonly Json[];
    readonly listed: readonly string[];
}

// `--attach a.pdf,b.docx`: workspace files, sent as Graph file attachments.
const attachedFiles = async (ctx: CommandContext): Promise<Attached> => {
    const paths = (ctx.flag("attach") ?? "")
        .split(",")
        .map((path) => path.trim())
        .filter((path) => path !== "");
    const attachments: Json[] = [];
    const listed: string[] = [];
    let total = 0;
    for (const path of paths) {
        const bytes = await readFile(await workspaceFile(ctx.root, path, false));
        total += bytes.length;
        if (total > ATTACH_MAX_BYTES) {
            throw new Error("Attachments over 3 MB in total cannot go in one message: share a OneDrive link instead (m365 files upload)");
        }
        attachments.push({ "@odata.type": "#microsoft.graph.fileAttachment", name: basename(path), contentBytes: bytes.toString("base64") });
        listed.push(`${basename(path)} (${kilobytes(bytes.length)})`);
    }
    return { attachments, listed };
};

const withAttachments = (message: Message, attached: Attached): Message =>
    attached.attachments.length === 0 ? message : { ...message, attachments: [...(message.attachments ?? []), ...attached.attachments] };

const attachmentLines = (message: Message, attached: Attached): string => {
    const own = (message.attachments?.length ?? 0) - attached.attachments.length;
    const named = [...attached.listed, ...(own > 0 ? [`${own} attachment(s) from the request file`] : [])];
    return named.length === 0 ? "none" : named.join(", ");
};

// What the owner reads before saying yes: the whole message, not a summary of it.
const messageDetails = (account: string, message: Message, attached: Attached): string =>
    [
        `From: the ${account} Microsoft 365 mailbox`,
        `To: ${addresses(message.toRecipients)}`,
        `Cc: ${addresses(message.ccRecipients)}`,
        ...(message.bccRecipients === undefined ? [] : [`Bcc: ${addresses(message.bccRecipients)}`]),
        `Subject: ${message.subject ?? "(none)"}`,
        "",
        message.comment ?? message.body?.content ?? "(empty)",
        "",
        `Attachments: ${attachmentLines(message, attached)}`,
    ].join("\n");

const folderPath = (folder: string | undefined): string => (folder === undefined ? "/me" : `/me/mailFolders/${segment(folder)}`);

const read = async (ctx: CommandContext): Promise<Json> => {
    const body = ctx.flag("body") ?? "text";
    if (body !== "text" && body !== "html") {
        throw new Error("--body takes text or html");
    }
    // Graph answers HTML unless asked; text is what an agent reads, and what a hostile message cannot hide markup in.
    const message = await ctx.graph.call<Json>(`/me/messages/${segment(ctx.id())}`, { headers: { Prefer: `outlook.body-content-type="${body}"` } });
    const directory = ctx.flag("attachments");
    const saved = directory === undefined ? [] : await saveAttachments(ctx.graph, ctx.root, ctx.id(), directory);
    return { message, savedAttachments: saved };
};

type Verb = "reply" | "replyAll" | "forward";

const VERB_WORDS = { reply: "Reply to", replyAll: "Reply to everyone on", forward: "Forward" } as const satisfies Record<Verb, string>;

// Who a response goes to as Graph sends it: recipients the request names win over the original's.
const recipientsOf = (verb: Verb, original: Message, request: Message): string => {
    const named = request.toRecipients ?? request.message?.toRecipients;
    if (verb === "forward" || named !== undefined) {
        return addresses(named);
    }
    const sender = addresses([original.from ?? {}]);
    return verb === "replyAll" ? [sender, addresses(original.toRecipients), addresses(original.ccRecipients)].join(", ") : sender;
};

// Reply, reply-all and forward: the original's subject and sender go on the approval, so the owner sees what is
// being answered without opening Outlook.
const respond =
    (verb: Verb) =>
    async (ctx: CommandContext): Promise<Json> => {
        const original = await ctx.graph.call<Message>(`/me/messages/${segment(ctx.id())}?$select=subject,from,toRecipients,ccRecipients`);
        const request = await messageFile(ctx);
        const attached = await attachedFiles(ctx);
        // Workspace files join whatever the request's own `message` already carries, rather than replacing it.
        const body = attached.attachments.length === 0 ? request : { ...request, message: withAttachments(request.message ?? {}, attached) };
        const to = recipientsOf(verb, original, request);
        const answered = `${VERB_WORDS[verb]} "${original.subject ?? "(no subject)"}"`;
        const cc = request.message?.ccRecipients;
        // SAFETY: built from the request object and Graph JSON only.
        return ctx.act({
            key: "microsoft365.mail.send",
            path: `/me/messages/${segment(ctx.id())}/${verb}`,
            method: "POST",
            body: body as Json,
            summary: `${answered} — to ${to}`,
            details: [
                `${answered} from ${addresses([original.from ?? {}])}`,
                `Goes to: ${to}`,
                ...(cc === undefined ? [] : [`Cc: ${addresses(cc)}`]),
                "",
                request.comment ?? request.message?.body?.content ?? "(no text)",
                "",
                `Attachments: ${attached.listed.join(", ") || "none"}`,
            ].join("\n"),
        });
    };

export const mailCommands: Commands = {
    folders: async (ctx) => {
        const parent = ctx.flag("folder");
        const path = parent === undefined ? "/me/mailFolders" : `/me/mailFolders/${segment(parent)}/childFolders`;
        const folders = await ctx.graph.list<{ readonly displayName?: string } & Json>(`${path}?includeHiddenFolders=true&$top=${PAGE_MAX}`, 1000);
        const wanted = ctx.flag("search")?.toLocaleLowerCase();
        return wanted === undefined ? folders : folders.filter((folder) => folder.displayName?.toLocaleLowerCase().includes(wanted) === true);
    },
    list: async (ctx) => {
        const limit = ctx.limit(25);
        const filter = ctx.flag("filter");
        // Graph refuses $orderby next to most $filters on messages, so a filtered list keeps Graph's own order.
        const params = {
            $select: LIST_FIELDS,
            $top: String(Math.min(limit, PAGE_MAX)),
            $filter: filter,
            $orderby: filter === undefined ? "receivedDateTime desc" : undefined,
        };
        return ctx.graph.list<Json>(`${folderPath(ctx.flag("folder") ?? "inbox")}/messages?${query(params)}`, limit);
    },
    search: async (ctx) => {
        const limit = ctx.limit(25);
        const params = { $search: JSON.stringify(ctx.required("query")), $select: LIST_FIELDS, $top: String(Math.min(limit, PAGE_MAX)) };
        return ctx.graph.list<Json>(`${folderPath(ctx.flag("folder"))}/messages?${query(params)}`, limit);
    },
    read,
    // A draft lands in the mailbox's Drafts folder and goes nowhere: a write, not a send, so it needs no approval.
    draft: async (ctx) => {
        const message = withAttachments(await messageFile(ctx), await attachedFiles(ctx));
        // SAFETY: built from the request object and Graph JSON only.
        const created = await ctx.graph.call<{ readonly id?: string; readonly webLink?: string }>("/me/messages", {
            method: "POST",
            body: message as Json,
        });
        return { draft: created.id ?? null, webLink: created.webLink ?? null };
    },
    send: async (ctx) => {
        const attached = await attachedFiles(ctx);
        const message = withAttachments(await messageFile(ctx), attached);
        return ctx.act({
            key: "microsoft365.mail.send",
            path: "/me/sendMail",
            method: "POST",
            // SAFETY: built from the request object and Graph JSON only.
            body: { message: message as Json, saveToSentItems: true },
            summary: `Send "${message.subject ?? "(no subject)"}" — to ${addresses(message.toRecipients)}`,
            details: messageDetails(ctx.graph.account.id, message, attached),
        });
    },
    reply: respond("reply"),
    "reply-all": respond("replyAll"),
    forward: respond("forward"),
};
