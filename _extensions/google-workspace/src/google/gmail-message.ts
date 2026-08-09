/* A GMAIL MESSAGE AS SOMETHING WORTH READING. The API hands back a recursive part tree with base64url bodies
 * and headers as an array of {name, value} pairs, and every consumer here — read, reply, the watcher's excerpt
 * — wants the same four things out of it: who, what it is about, the text, what is attached.
 *
 * THE TEXT IS `text/plain` WHERE THERE IS ONE, and a stripped `text/html` where there isn't. A great many
 * messages are html-only, and returning nothing for them would make the tool useless on exactly the mail
 * people get most (anything sent by a system). The stripping is deliberately crude — block tags become line
 * breaks, everything else goes — because the reader is a model summarizing prose, not a browser. */

export interface MessagePart {
    readonly partId?: string;
    readonly mimeType?: string;
    readonly filename?: string;
    readonly headers?: readonly { readonly name: string; readonly value: string }[];
    readonly body?: { readonly size?: number; readonly data?: string; readonly attachmentId?: string };
    readonly parts?: readonly MessagePart[];
}

export interface GmailMessage {
    readonly id: string;
    readonly threadId?: string;
    readonly labelIds?: readonly string[];
    readonly snippet?: string;
    readonly internalDate?: string;
    readonly payload?: MessagePart;
}

export interface ParsedAttachment {
    readonly id: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
}

export interface ParsedMessage {
    readonly id: string;
    readonly threadId: string;
    readonly from: string;
    readonly to: string;
    readonly cc: string;
    readonly subject: string;
    readonly date: string;
    readonly messageId: string;
    readonly references: string;
    readonly labels: readonly string[];
    readonly text: string;
    readonly attachments: readonly ParsedAttachment[];
}

export const headerOf = (part: MessagePart | undefined, name: string): string =>
    part?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const decode = (data: string | undefined): string => (data === undefined ? "" : Buffer.from(data, "base64url").toString("utf8"));

const BLOCK = /<\/(?:p|div|tr|li|h[1-6]|blockquote)>|<br\s*\/?>/gi;

export const stripHtml = (html: string): string =>
    html
        .replaceAll(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replaceAll(BLOCK, "\n")
        .replaceAll(/<[^>]+>/g, "")
        .replaceAll("&nbsp;", " ")
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&#39;", "'")
        .replaceAll(/[ \t]+\n/g, "\n")
        .replaceAll(/\n{3,}/g, "\n\n")
        .trim();

const walk = (part: MessagePart | undefined, visit: (part: MessagePart) => void): void => {
    if (part === undefined) {
        return;
    }
    visit(part);
    for (const child of part.parts ?? []) {
        walk(child, visit);
    }
};

export const bodyText = (payload: MessagePart | undefined): string => {
    const plain: string[] = [];
    const html: string[] = [];
    walk(payload, (part) => {
        // A part with a filename is an attachment even when its type is text/plain — a .txt someone sent is
        // not the message.
        if ((part.filename ?? "") !== "" || part.body?.data === undefined) {
            return;
        }
        if (part.mimeType === "text/plain") {
            plain.push(decode(part.body.data));
        } else if (part.mimeType === "text/html") {
            html.push(decode(part.body.data));
        }
    });
    if (plain.length > 0) {
        return plain.join("\n").trim();
    }
    return stripHtml(html.join("\n"));
};

export const attachmentsOf = (payload: MessagePart | undefined): ParsedAttachment[] => {
    const found: ParsedAttachment[] = [];
    walk(payload, (part) => {
        const filename = part.filename ?? "";
        const id = part.body?.attachmentId;
        if (filename === "" || id === undefined) {
            return;
        }
        found.push({ id, filename, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 });
    });
    return found;
};

export const parseMessage = (message: GmailMessage): ParsedMessage => ({
    id: message.id,
    threadId: message.threadId ?? message.id,
    from: headerOf(message.payload, "From"),
    to: headerOf(message.payload, "To"),
    cc: headerOf(message.payload, "Cc"),
    subject: headerOf(message.payload, "Subject"),
    date: headerOf(message.payload, "Date"),
    messageId: headerOf(message.payload, "Message-ID"),
    references: headerOf(message.payload, "References"),
    labels: message.labelIds ?? [],
    text: bodyText(message.payload),
    attachments: attachmentsOf(message.payload),
});

// The address out of a `Name <addr@host>` header, for a reply's To and for the watcher's author field.
export const addressOf = (header: string): string => /<([^>]+)>/.exec(header)?.[1]?.trim() ?? header.trim();

// The display name, falling back to the address — what a person is called in a listing.
export const nameOf = (header: string): string => {
    const named = /^\s*"?([^"<]*?)"?\s*</.exec(header)?.[1]?.trim();
    return named === undefined || named === "" ? addressOf(header) : named;
};

// A reply's subject: one "Re:" however many round trips it has been through.
export const replySubject = (subject: string): string => (/^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);
