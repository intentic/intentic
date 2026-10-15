import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
// The subpath, not the package root: the root loads every schema in the contract, which a send never needs.
import { STATE_GROUP_DIR } from "@intentic/sandbox-contract/workspace-state";

// Where the approvals queue reads items from: one JSON file per approval, written by the agent and administered by the
// daemon (schemas/approvals.ts in the contract), and where this extension's settings are read.
export const approvalsDir = (root: string): string => join(root, STATE_GROUP_DIR.config, "approvals");
export const settingsFile = (root: string): string => join(root, STATE_GROUP_DIR.config, "settings.json");

export interface MailDraft {
    readonly to: string[];
    readonly cc?: string[];
    readonly subject: string;
    readonly text: string;
    readonly html?: string;
    readonly inReplyTo?: string;
    readonly references?: string[];
    readonly attachments?: readonly { path: string; name?: string; contentType?: string }[];
}

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

export const buildMessage = async (from: string, draft: MailDraft): Promise<Buffer> => {
    address(from);
    if (draft.to.length === 0) {throw new Error("at least one recipient is required");}
    const headers = [
        `From: ${from}`,
        `To: ${draft.to.map(address).join(", ")}`,
        ...(draft.cc?.length ? [`Cc: ${draft.cc.map(address).join(", ")}`] : []),
        `Subject: ${encoded(draft.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomUUID()}@${from.split("@")[1]}>`,
        ...(draft.inReplyTo ? [`In-Reply-To: ${header(draft.inReplyTo)}`] : []),
        ...(draft.references?.length ? [`References: ${draft.references.map(header).join(" ")}`] : []),
        "MIME-Version: 1.0",
    ];
    const textPart = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", lines(Buffer.from(draft.text))];
    const alternative = `intentic-alternative-${randomUUID()}`;
    const body = draft.html === undefined ? textPart : [
        `Content-Type: multipart/alternative; boundary="${alternative}"`, "",
        `--${alternative}`, ...textPart, `--${alternative}`, "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64", "", lines(Buffer.from(draft.html)), `--${alternative}--`, "",
    ];
    const attachments = draft.attachments ?? [];
    if (attachments.length === 0) {return Buffer.from([...headers, ...body, ""].join("\r\n"));}
    const boundary = `intentic-${randomUUID()}`;
    const parts = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, ...body];
    for (const attachment of attachments) {
        const name = header(attachment.name ?? attachment.path.split("/").at(-1) ?? "attachment");
        if (!/^[\x20-\x7e]+$/.test(name) || /["\\]/.test(name)) {throw new Error("attachment name must be printable ASCII without quotes");}
        const contentType = header(attachment.contentType ?? "application/octet-stream");
        parts.push(`--${boundary}`, `Content-Type: ${contentType}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", lines(await readFile(attachment.path)));
    }
    parts.push(`--${boundary}--`, "");
    return Buffer.from(parts.join("\r\n"));
};

export const sendRule = (rules: Record<string, string> | undefined): "allow" | "hold" | "deny" => {
    const value = rules?.["imap.message.send"] ?? rules?.["imap.*"];
    return value === "allow" || value === "deny" ? value : "hold";
};

export const draftDigest = async (draft: MailDraft): Promise<string> => {
    const hash = createHash("sha256").update(JSON.stringify(draft));
    for (const attachment of draft.attachments ?? []) {hash.update(await readFile(attachment.path));}
    return hash.digest("hex");
};

export const prepareApproval = async (root: string, draft: MailDraft, account?: string): Promise<string> => {
    const id = `imap-send-${randomUUID()}`;
    const dir = approvalsDir(root);
    const media = join(dir, "media");
    await mkdir(media, { recursive: true, mode: 0o700 });
    const draftPath = join(media, `${id}.json`);
    await writeFile(draftPath, JSON.stringify(draft, null, 2), { mode: 0o600, flag: "wx" });
    const recipients = [...draft.to, ...(draft.cc ?? [])].join(", ");
    const item = {
        kind: "action", summary: `Send email to ${recipients}: ${draft.subject}`,
        details: `To: ${draft.to.join(", ")}\nCc: ${(draft.cc ?? []).join(", ")}\nSubject: ${draft.subject}\n\n${draft.text}\n\nHTML: ${draft.html ?? "none"}\n\nAttachments: ${(draft.attachments ?? []).map((a) => a.path).join(", ") || "none"}`,
        instructions: `Send only the draft in ${draftPath}: run \`imap${account === undefined ? "" : ` --account ${account}`} send ${draftPath} --approval-id ${id}\`. It checks the SHA-256 draft and attachment digest ${await draftDigest(draft)} before sending. Report the SMTP result; never retry an uncertain send blind.`,
        status: "proposed", createdAt: Date.now(),
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(item, null, 2), { mode: 0o600, flag: "wx" });
    return id;
};

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

const runCurl = async (args: string[], mime: Buffer): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("curl", args, { stdio: ["pipe", "ignore", "pipe"] });
        let error = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            error += chunk.toString().slice(0, 300);
        });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`SMTP delivery failed (${code}): ${error}`))));
        child.stdin?.end(mime);
    });
};

const curlTransport = (args: string[], mime: Buffer, login: string): Promise<void> =>
    withCurlLogin(login, (config) => runCurl([...args, "--config", config], mime));

export const deliver = async (
    config: SmtpConfig,
    from: string,
    draft: MailDraft,
    transport: (args: string[], mime: Buffer, login: string) => Promise<void> = curlTransport,
): Promise<void> => {
    if (!config.host || !config.username || credentialMissing(config.credential)) {
        throw new Error("SMTP connection is incomplete: set the SMTP host on the IMAP card");
    }
    const recipients = [...draft.to, ...(draft.cc ?? [])].map(address);
    const mime = await buildMessage(from, draft);
    const url = `${config.security === "tls" ? "smtps" : "smtp"}://${config.host}:${config.port}`;
    const args = ["--fail", "--silent", "--show-error", "--ssl-reqd", "--url", url, "--mail-from", address(from), ...recipients.flatMap((r) => ["--mail-rcpt", r]), "--upload-file", "-"];
    await transport(args, mime, curlLogin(config.username, config.credential));
};
