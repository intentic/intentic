import { basename } from "node:path";

/* BUILDING THE MESSAGE GMAIL ACTUALLY SENDS. Gmail's send endpoint takes an RFC 5322 message, not a JSON
 * object with a `to` and a `body`, so composing one is unavoidable, and getting it slightly wrong is how mail
 * arrives with a mangled subject or an attachment nobody can open.
 *
 * Two decisions carry most of that: headers with non-ASCII in them are encoded per RFC 2047 (otherwise an
 * em dash in a subject line reaches the recipient as mojibake), and the body is base64 rather than quoted-
 * printable (which needs soft line breaks at 76 columns, and a body that is one long URL is exactly where a
 * hand-rolled quoted-printable encoder breaks the URL). */

export interface Attachment {
    readonly filename: string;
    readonly contentType: string;
    readonly data: Buffer;
}

export interface Draft {
    readonly to: readonly string[];
    readonly cc?: readonly string[];
    readonly bcc?: readonly string[];
    readonly from?: string;
    readonly subject: string;
    readonly body: string;
    readonly attachments?: readonly Attachment[];
    // In-Reply-To / References on a reply; nothing else ever sets these.
    readonly headers?: Readonly<Record<string, string>>;
}

// RFC 2047, base64 form. Plain ASCII passes through, an encoded-word where none is needed is legal but makes
// every subject line unreadable in the one place a human might look at the raw message.
export const encodeHeader = (value: string): string =>
    /^[ -~]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const wrap = (base64: string): string => (base64.match(/.{1,76}/g) ?? []).join("\r\n");

const headerLines = (draft: Draft, boundary: string | undefined): string[] => [
    ...(draft.from === undefined ? [] : [`From: ${draft.from}`]),
    `To: ${draft.to.join(", ")}`,
    ...(draft.cc === undefined || draft.cc.length === 0 ? [] : [`Cc: ${draft.cc.join(", ")}`]),
    ...(draft.bcc === undefined || draft.bcc.length === 0 ? [] : [`Bcc: ${draft.bcc.join(", ")}`]),
    `Subject: ${encodeHeader(draft.subject)}`,
    ...Object.entries(draft.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    "MIME-Version: 1.0",
    ...(boundary === undefined
        ? ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"]
        : [`Content-Type: multipart/mixed; boundary="${boundary}"`]),
];

export const buildMessage = (draft: Draft, boundarySeed: string): string => {
    const attachments = draft.attachments ?? [];
    if (attachments.length === 0) {
        return [...headerLines(draft, undefined), "", wrap(Buffer.from(draft.body, "utf8").toString("base64"))].join("\r\n");
    }
    const boundary = `gw-${boundarySeed}`;
    const parts = [
        [
            `--${boundary}`,
            "Content-Type: text/plain; charset=UTF-8",
            "Content-Transfer-Encoding: base64",
            "",
            wrap(Buffer.from(draft.body, "utf8").toString("base64")),
        ].join("\r\n"),
        ...attachments.map((attachment) =>
            [
                `--${boundary}`,
                `Content-Type: ${attachment.contentType}; name="${encodeHeader(basename(attachment.filename))}"`,
                "Content-Transfer-Encoding: base64",
                `Content-Disposition: attachment; filename="${encodeHeader(basename(attachment.filename))}"`,
                "",
                wrap(attachment.data.toString("base64")),
            ].join("\r\n"),
        ),
    ];
    return [...headerLines(draft, boundary), "", ...parts, `--${boundary}--`, ""].join("\r\n");
};

// What Gmail's `raw` field takes.
export const encodeRaw = (message: string): string => Buffer.from(message, "utf8").toString("base64url");

// A file's content type from its name, enough for the formats people actually attach. Everything else is
// octet-stream, which every mail client handles by offering to save it.
const TYPES: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    zip: "application/zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const contentTypeOf = (filename: string): string => TYPES[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
