import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";

// A mail as it goes out: composed into MIME and handed to the card's SMTP server by curl, with the login in a 0600 file.
// Runs in the extension's backend (server.ts), the only place the card's credential is; the agent's `imap send` reads
// its draft and attachments from the workspace and hands them over (cli.ts).

const Addresses = z.array(z.string().min(1).max(320)).max(500);

// One attachment, its bytes carried along rather than its path: the backend cannot see the agent's checkout, and a held
// send must go out exactly as it was when the owner read it.
export const OutgoingAttachmentSchema = z.object({
    name: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255).optional(),
    data: z.base64(),
});
export type OutgoingAttachment = z.infer<typeof OutgoingAttachmentSchema>;

export const OutgoingMailSchema = z.object({
    to: Addresses.min(1),
    cc: Addresses.optional(),
    subject: z.string().max(998),
    text: z.string(),
    html: z.string().optional(),
    inReplyTo: z.string().max(998).optional(),
    references: z.array(z.string().max(998)).max(100).optional(),
    attachments: z.array(OutgoingAttachmentSchema).max(100).optional(),
});
export type OutgoingMail = z.infer<typeof OutgoingMailSchema>;

const header = (value: string): string => {
    if (/[\r\n]/.test(value)) {throw new Error("newline in mail header");}
    return value;
};
const address = (value: string): string => {
    header(value);
    if (!/^[^\s<>@,]+@[^\s<>@,]+$/.test(value)) {throw new Error(`invalid mail address: ${value}`);}
    return value;
};
const encoded = (value: string): string => /[^\x20-\x7e]/.test(value) ? `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=` : header(value);
const lines = (value: Buffer): string => value.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();

export const buildMessage = (from: string, mail: OutgoingMail): Buffer => {
    address(from);
    if (mail.to.length === 0) {throw new Error("at least one recipient is required");}
    const headers = [
        `From: ${from}`,
        `To: ${mail.to.map(address).join(", ")}`,
        ...(mail.cc?.length ? [`Cc: ${mail.cc.map(address).join(", ")}`] : []),
        `Subject: ${encoded(mail.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomUUID()}@${from.split("@")[1]}>`,
        ...(mail.inReplyTo ? [`In-Reply-To: ${header(mail.inReplyTo)}`] : []),
        ...(mail.references?.length ? [`References: ${mail.references.map(header).join(" ")}`] : []),
        "MIME-Version: 1.0",
    ];
    const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", lines(Buffer.from(mail.text))];
    const alternative = `intentic-alternative-${randomUUID()}`;
    const body = mail.html === undefined ? textPart : [
        `Content-Type: multipart/alternative; boundary="${alternative}"`, "",
        `--${alternative}`, ...textPart, `--${alternative}`, "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64", "", lines(Buffer.from(mail.html)), `--${alternative}--`, "",
    ];
    const attachments = mail.attachments ?? [];
    if (attachments.length === 0) {return Buffer.from([...headers, ...body, ""].join("\r\n"));}
    const boundary = `intentic-${randomUUID()}`;
    const parts = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ...body];
    for (const attachment of attachments) {
        const name = header(attachment.name);
        if (!/^[\x20-\x7e]+$/.test(name) || /["\\]/.test(name)) {throw new Error("attachment name must be printable ASCII without quotes");}
        const contentType = header(attachment.contentType ?? "application/octet-stream");
        parts.push(`--${boundary}`, `Content-Type: ${contentType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", lines(Buffer.from(attachment.data, "base64")));
    }
    parts.push(`--${boundary}--`, "");
    return Buffer.from(parts.join("\r\n"));
};

/** Who it goes to, as the approval and the Activity row name them. */
export const recipientsOf = (mail: OutgoingMail): string => [...mail.to, ...(mail.cc ?? [])].join(", ");

/** What the owner reads before saying yes: everything that goes out, both bodies and every attachment by name and size. */
export const mailDetails = (from: string, mail: OutgoingMail): string =>
    [
        `From: ${from}`,
        `To: ${mail.to.join(", ")}`,
        `Cc: ${(mail.cc ?? []).join(", ")}`,
        `Subject: ${mail.subject}`,
        "",
        mail.text,
        "",
        `HTML: ${mail.html ?? "none"}`,
        "",
        `Attachments: ${(mail.attachments ?? []).map((each) => `${each.name} (${Buffer.from(each.data, "base64").length} bytes)`).join(", ") || "none"}`,
    ].join("\n");

// How a login proves itself: the password, or an OAuth2 access token (SASL XOAUTH2).
export type MailCredential = { readonly password: string } | { readonly accessToken: string };

export interface SmtpConfig {
    readonly host: string;
    readonly port: number;
    readonly security: "starttls" | "tls";
    readonly username: string;
    readonly credential: MailCredential;
}

const credentialMissing = (credential: MailCredential): boolean => ("password" in credential ? credential.password : credential.accessToken) === "";

// The login as a curl config: curl reads it from a file only this user can read, never from its command line, where
// every process in the sandbox could read it from the process list for as long as the command runs.
export const curlLogin = (username: string, credential: MailCredential): string =>
    "password" in credential
        ? `user = ${JSON.stringify(`${username}:${credential.password}`)}\n`
        : `user = ${JSON.stringify(`${username}:`)}\noauth2-bearer = ${JSON.stringify(credential.accessToken)}\nlogin-options = "AUTH=XOAUTH2"\n`;

// Runs curl with `login` in a 0600 config file that is gone once curl exits.
export const withCurlLogin = async <T>(login: string, run: (configPath: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), "imap-curl-"));
    const config = join(dir, "curl.conf");
    try {
        await writeFile(config, login, { mode: 0o600 });
        return await run(config);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

// curl's exit codes for a send that never reached the server's acceptance of the message: no such host, no connection,
// no TLS, the login refused. Anything else may have been accepted before the answer was lost.
const NOT_SENT_CODES = new Set([6, 7, 35, 60, 67]);

// A failed delivery, with whether the message may still have gone.
export class DeliveryError extends Error {
    constructor(
        message: string,
        readonly maybeSent: boolean,
    ) {
        super(message);
    }
}

const runCurl = async (args: string[], mime: Buffer): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("curl", args, { stdio: ["pipe", "ignore", "pipe"] });
        let error = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            error += chunk.toString().slice(0, 300);
        });
        child.on("error", (failure) => reject(new DeliveryError(`SMTP delivery could not start: ${failure.message}`, false)));
        child.on("close", (code) =>
            code === 0 ? resolve() : reject(new DeliveryError(`SMTP delivery failed (${code}): ${error}`, !NOT_SENT_CODES.has(code ?? -1))),
        );
        child.stdin?.end(mime);
    });
};

const curlTransport = (args: string[], mime: Buffer, login: string): Promise<void> =>
    withCurlLogin(login, (config) => runCurl([...args, "--config", config], mime));

// What hands a composed message to the SMTP server: curl, with the login in a file beside its arguments.
export type Transport = (args: string[], mime: Buffer, login: string) => Promise<void>;

export const deliver = async (config: SmtpConfig, from: string, mail: OutgoingMail, transport: Transport = curlTransport): Promise<void> => {
    if (!config.host || !config.username || credentialMissing(config.credential)) {
        throw new DeliveryError("SMTP connection is incomplete: set the SMTP host on the IMAP card", false);
    }
    const recipients = [...mail.to, ...(mail.cc ?? [])].map(address);
    const mime = buildMessage(from, mail);
    const url = `${config.security === "tls" ? "smtps" : "smtp"}://${config.host}:${config.port}`;
    const args = ["--fail", "--silent", "--show-error", "--ssl-reqd", "--url", url, "--mail-from", address(from), ...recipients.flatMap((r) => ["--mail-rcpt", r]), "--upload-file", "-"];
    await transport(args, mime, curlLogin(config.username, config.credential));
};
