import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Args, bool, flag, list, positional, required, limit as readLimit } from "../cli/args.js";
import { type Command, type CommandContext, type CommandGroup, printJson } from "../cli/command.js";
import { clip, count, row, tally, when } from "../cli/format.js";
import { mapLimit } from "../google/batch.js";
import { type GmailMessage, type ParsedMessage, addressOf, headerOf, nameOf, parseMessage, replySubject } from "../google/gmail-message.js";
import { type Attachment, type Draft, buildMessage, contentTypeOf, encodeRaw } from "../google/mime.js";
import { call, paginate } from "../google/request.js";
import type { Session } from "../google/session.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// The headers a listing needs. Asking for `metadata` rather than `full` is the difference between a search
// that fetches subject lines and one that downloads every body in the result set.
const LIST_HEADERS = ["From", "To", "Subject", "Date"];

const messagesMatching = async (session: Session, query: string, wanted: number): Promise<{ id: string }[]> =>
    paginate<{ id: string }>(
        session,
        { url: `${API}/messages`, query: { q: query } },
        { itemsOf: (page) => page["messages"] as { id: string }[] | undefined, limit: wanted, sizeKey: "maxResults", maxPageSize: 100 },
    );

const hydrate = async (session: Session, ids: readonly { id: string }[], format: "metadata" | "full"): Promise<ParsedMessage[]> => {
    const messages = await mapLimit(ids, 8, ({ id }) =>
        call<GmailMessage>(session, {
            url: `${API}/messages/${encodeURIComponent(id)}`,
            query: { format, metadataHeaders: format === "metadata" ? LIST_HEADERS : undefined },
        }),
    );
    return messages.map(parseMessage);
};

// `UNREAD`/`INBOX`-style system labels are their own ids; a user label is not, so names are resolved against
// the account's own list. Resolving by name is the point — nobody knows their label ids.
const resolveLabels = async (session: Session, names: readonly string[]): Promise<string[]> => {
    if (names.length === 0) {
        return [];
    }
    const { labels = [] } = await call<{ labels?: { id: string; name: string }[] }>(session, { url: `${API}/labels` });
    return names.map((name) => {
        const found = labels.find((label) => label.name.toLowerCase() === name.toLowerCase() || label.id === name);
        if (found === undefined) {
            throw new Error(`No Gmail label called "${name}". Existing labels: ${labels.map((label) => label.name).join(", ")}.`);
        }
        return found.id;
    });
};

const listLine = (message: ParsedMessage): string =>
    row(
        message.id,
        when(message.date),
        clip(nameOf(message.from), 24),
        clip(message.subject === "" ? "(no subject)" : message.subject, 72),
        message.attachments.length > 0 ? `📎${message.attachments.length}` : undefined,
        message.labels.includes("UNREAD") ? "unread" : undefined,
    );

// --body TEXT or --body-file PATH. A file is how anything with newlines in it gets here intact — a shell
// argument that has been through two levels of quoting rarely survives with its formatting.
const bodyOf = async (args: Args): Promise<string> => {
    const file = flag(args, "body-file");
    if (file !== undefined) {
        return readFile(file, "utf8");
    }
    return required(args, "body");
};

const attachmentsOf = async (args: Args): Promise<Attachment[]> =>
    Promise.all(
        list(args, "attach").map(async (path) => ({
            filename: basename(path),
            contentType: contentTypeOf(path),
            data: await readFile(path),
        })),
    );

const sendOrDraft = async (ctx: CommandContext, mode: "send" | "draft", overrides?: Partial<Draft>): Promise<void> => {
    const { args } = ctx;
    const from = flag(args, "from");
    const to = overrides?.to ?? list(args, "to");
    if (to.length === 0) {
        throw new Error("Nobody to send to — pass --to with at least one address.");
    }
    const draft: Draft = {
        to,
        cc: list(args, "cc"),
        bcc: list(args, "bcc"),
        subject: overrides?.subject ?? required(args, "subject"),
        body: await bodyOf(args),
        attachments: await attachmentsOf(args),
        ...(from === undefined ? {} : { from }),
        ...(overrides?.headers === undefined ? {} : { headers: overrides.headers }),
    };
    const message = buildMessage(draft, process.hrtime.bigint().toString(36));
    const raw = encodeRaw(message);
    // Set by `reply` so the answer lands in the conversation rather than starting a new one.
    const threadId = flag(args, "thread");
    const sent = await call<{ id: string; threadId?: string; message?: { id: string } }>(ctx.session, {
        method: "POST",
        url: mode === "send" ? `${API}/messages/send` : `${API}/drafts`,
        body: mode === "send" ? { raw, threadId } : { message: { raw, threadId } },
    });
    if (ctx.json) {
        printJson(ctx, sent);
        return;
    }
    ctx.out(mode === "send" ? `sent ${sent.id}` : `draft ${sent.id} (not sent — it is in Drafts)`);
};

const search: Command = {
    name: "search",
    summary: "Find mail with Gmail's own search syntax",
    usage: 'gw mail search "<query>" [-n 20]',
    run: async (ctx) => {
        const query = ctx.args.positional.slice(1).join(" ");
        if (query === "") {
            throw new Error('A query is required — Gmail search syntax, e.g. "from:ana is:unread newer_than:7d".');
        }
        const wanted = readLimit(ctx.args, 20, 200);
        const messages = await hydrate(ctx.session, await messagesMatching(ctx.session, query, wanted), "metadata");
        if (ctx.json) {
            printJson(ctx, messages);
            return;
        }
        for (const message of messages) {
            ctx.out(listLine(message));
        }
        ctx.out(tally(messages.length, wanted, "messages"));
    },
};

const read: Command = {
    name: "read",
    summary: "Read one message in full",
    usage: "gw mail read <messageId>",
    run: async (ctx) => {
        const message = parseMessage(
            await call<GmailMessage>(ctx.session, {
                url: `${API}/messages/${encodeURIComponent(positional(ctx.args, 1, "A message id"))}`,
                query: { format: "full" },
            }),
        );
        if (ctx.json) {
            printJson(ctx, message);
            return;
        }
        ctx.out(`From: ${message.from}`);
        ctx.out(`To: ${message.to}`);
        if (message.cc !== "") {
            ctx.out(`Cc: ${message.cc}`);
        }
        ctx.out(`Date: ${message.date}`);
        ctx.out(`Subject: ${message.subject}`);
        ctx.out(`Labels: ${message.labels.join(", ")}`);
        for (const attachment of message.attachments) {
            ctx.out(`Attachment: ${attachment.filename} (${attachment.mimeType}, ${attachment.size} bytes, id ${attachment.id})`);
        }
        ctx.out("");
        ctx.out(message.text);
    },
};

const thread: Command = {
    name: "thread",
    summary: "Read a whole conversation",
    usage: "gw mail thread <threadId>",
    run: async (ctx) => {
        const found = await call<{ messages?: GmailMessage[] }>(ctx.session, {
            url: `${API}/threads/${encodeURIComponent(positional(ctx.args, 1, "A thread id"))}`,
            query: { format: "full" },
        });
        const messages = (found.messages ?? []).map(parseMessage);
        if (ctx.json) {
            printJson(ctx, messages);
            return;
        }
        for (const message of messages) {
            ctx.out(`--- ${message.id}  ${when(message.date)}  ${message.from}`);
            ctx.out(message.text);
            ctx.out("");
        }
        ctx.out(count(messages.length, "messages in the thread"));
    },
};

const send: Command = {
    name: "send",
    summary: "Send a message",
    usage: 'gw mail send --to a@x.com[,b@y.com] --subject "…" --body "…" [--cc] [--bcc] [--from] [--body-file F] [--attach path,path]',
    writes: true,
    run: (ctx) => sendOrDraft(ctx, "send"),
};

const draft: Command = {
    name: "draft",
    summary: "Compose a draft without sending it",
    usage: 'gw mail draft --to a@x.com --subject "…" --body "…" [same flags as send]',
    writes: true,
    run: (ctx) => sendOrDraft(ctx, "draft"),
};

const reply: Command = {
    name: "reply",
    summary: "Reply in the thread of an existing message",
    usage: 'gw mail reply <messageId> --body "…" [--all] [--attach path]',
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A message id");
        const original = await call<GmailMessage>(ctx.session, {
            url: `${API}/messages/${encodeURIComponent(id)}`,
            query: { format: "metadata", metadataHeaders: [...LIST_HEADERS, "Message-ID", "References", "Reply-To"] },
        });
        const parsed = parseMessage(original);
        const replyTo = headerOf(original.payload, "Reply-To");
        const to = [addressOf(replyTo === "" ? parsed.from : replyTo)];
        // --all keeps everyone who was on it, minus this account, which Gmail leaves in the To header.
        const everyone = bool(ctx.args, "all")
            ? [...parsed.to.split(","), ...parsed.cc.split(",")]
                  .map((entry) => addressOf(entry))
                  .filter((address) => address !== "" && address.toLowerCase() !== ctx.connection.email.toLowerCase() && !to.includes(address))
            : [];
        ctx.args.flags.set("thread", parsed.threadId);
        if (everyone.length > 0) {
            ctx.args.flags.set("cc", [...list(ctx.args, "cc"), ...everyone].join(","));
        }
        await sendOrDraft(ctx, "send", {
            to,
            subject: replySubject(parsed.subject),
            headers: {
                "In-Reply-To": parsed.messageId,
                References: `${parsed.references} ${parsed.messageId}`.trim(),
            },
        });
    },
};

const label: Command = {
    name: "label",
    summary: "Add or remove labels — archiving is removing INBOX",
    usage: "gw mail label <messageId> [--add Work,Urgent] [--remove INBOX,UNREAD]",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A message id");
        const [addLabelIds, removeLabelIds] = await Promise.all([
            resolveLabels(ctx.session, list(ctx.args, "add")),
            resolveLabels(ctx.session, list(ctx.args, "remove")),
        ]);
        if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
            throw new Error("Nothing to do — pass --add and/or --remove.");
        }
        const updated = await call<GmailMessage>(ctx.session, {
            method: "POST",
            url: `${API}/messages/${encodeURIComponent(id)}/modify`,
            body: { addLabelIds, removeLabelIds },
        });
        if (ctx.json) {
            printJson(ctx, updated);
            return;
        }
        ctx.out(`${id} now: ${(updated.labelIds ?? []).join(", ")}`);
    },
};

const trash: Command = {
    name: "trash",
    summary: "Move a message to the bin",
    usage: "gw mail trash <messageId>",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A message id");
        await call(ctx.session, { method: "POST", url: `${API}/messages/${encodeURIComponent(id)}/trash` });
        ctx.out(`${id} moved to the bin (recoverable for 30 days)`);
    },
};

const attachments: Command = {
    name: "attachments",
    summary: "List a message's attachments, or download them",
    usage: "gw mail attachments <messageId> [--download DIR]",
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "A message id");
        const message = parseMessage(
            await call<GmailMessage>(ctx.session, { url: `${API}/messages/${encodeURIComponent(id)}`, query: { format: "full" } }),
        );
        const into = flag(ctx.args, "download");
        if (into === undefined) {
            if (ctx.json) {
                printJson(ctx, message.attachments);
                return;
            }
            for (const attachment of message.attachments) {
                ctx.out(row(attachment.id, attachment.filename, attachment.mimeType, String(attachment.size)));
            }
            ctx.out(count(message.attachments.length, "attachments"));
            return;
        }
        for (const attachment of message.attachments) {
            const body = await call<{ data?: string }>(ctx.session, {
                url: `${API}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment.id)}`,
            });
            const path = join(into, attachment.filename);
            await writeFile(path, Buffer.from(body.data ?? "", "base64url"));
            ctx.out(path);
        }
    },
};

const labels: Command = {
    name: "labels",
    summary: "List the account's labels",
    usage: "gw mail labels",
    run: async (ctx) => {
        const { labels: found = [] } = await call<{ labels?: { id: string; name: string; type?: string }[] }>(ctx.session, { url: `${API}/labels` });
        if (ctx.json) {
            printJson(ctx, found);
            return;
        }
        for (const one of found) {
            ctx.out(row(one.id, one.name, one.type === "system" ? "system" : undefined));
        }
    },
};

export const mailGroup: CommandGroup = {
    name: "mail",
    summary: "Gmail — search, read, send, reply, label",
    commands: [search, read, thread, send, reply, draft, label, trash, attachments, labels],
};
