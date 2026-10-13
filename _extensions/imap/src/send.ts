import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { STATE_DIR } from "@intentic/sandbox-contract";

// Where the approvals queue reads items from: one JSON file per approval, written by the agent and administered by the
// daemon (schemas/approvals.ts in the contract), and where this extension's settings are read.
export const approvalsDir = (root: string): string => join(root, STATE_DIR, "config", "approvals");
export const settingsFile = (root: string): string => join(root, STATE_DIR, "config", "settings.json");

export interface MailDraft {
    readonly to: string[];
    readonly cc?: string[];
    readonly subject: string;
    readonly text: string;
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
    const attachments = draft.attachments ?? [];
    if (attachments.length === 0) {
        return Buffer.from([...headers, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", lines(Buffer.from(draft.text)), ""].join("\r\n"));
    }
    const boundary = `intentic-${randomUUID()}`;
    const parts = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", lines(Buffer.from(draft.text))];
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

export const prepareApproval = async (root: string, draft: MailDraft): Promise<string> => {
    const id = `imap-send-${randomUUID()}`;
    const dir = approvalsDir(root);
    const media = join(dir, "media");
    await mkdir(media, { recursive: true, mode: 0o700 });
    const draftPath = join(media, `${id}.json`);
    await writeFile(draftPath, JSON.stringify(draft, null, 2), { mode: 0o600, flag: "wx" });
    const recipients = [...draft.to, ...(draft.cc ?? [])].join(", ");
    const item = {
        kind: "action", summary: `Send email to ${recipients}: ${draft.subject}`,
        details: `To: ${draft.to.join(", ")}\nCc: ${(draft.cc ?? []).join(", ")}\nSubject: ${draft.subject}\n\n${draft.text}\n\nAttachments: ${(draft.attachments ?? []).map((a) => a.path).join(", ") || "none"}`,
        instructions: `Send only the draft in ${draftPath} using this IMAP connection. Run the IMAP sender with --approval-id ${id}; verify its SHA-256 draft and attachment digest ${await draftDigest(draft)} before sending. Report the SMTP result.`,
        status: "proposed", createdAt: Date.now(),
    };
    await writeFile(join(dir, `${id}.json`), JSON.stringify(item, null, 2), { mode: 0o600, flag: "wx" });
    return id;
};

export interface SmtpConfig {
    host: string;
    port: number;
    security: "starttls" | "tls";
    username: string;
    password: string;
}

// The password goes to curl in a config file only this user can read, never on its command line, where every process in
// the sandbox could read it from the process list for as long as the delivery runs.
export const curlTransport = async (args: string[], mime: Buffer, credentials: string): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "imap-send-"));
    const config = join(dir, "curl.conf");
    try {
        await writeFile(config, `user = ${JSON.stringify(credentials)}\n`, { mode: 0o600 });
        await runCurl([...args, "--config", config], mime);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

const runCurl = async (args: string[], mime: Buffer): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("curl", args, { stdio: ["pipe", "ignore", "pipe"] });
        let error = "";
        child.stderr?.on("data", (chunk: Buffer) => { error += chunk.toString().slice(0, 300); });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`SMTP delivery failed (${code}): ${error}`)));
        child.stdin?.end(mime);
    });
};

export const deliver = async (
    config: SmtpConfig,
    from: string,
    draft: MailDraft,
    transport: (args: string[], mime: Buffer, credentials: string) => Promise<void> = curlTransport,
): Promise<void> => {
    if (!config.host || !config.username || !config.password) {throw new Error("SMTP connection is incomplete");}
    const recipients = [...draft.to, ...(draft.cc ?? [])].map(address);
    const mime = await buildMessage(from, draft);
    const url = `${config.security === "tls" ? "smtps" : "smtp"}://${config.host}:${config.port}`;
    const args = ["--fail", "--silent", "--show-error", "--ssl-reqd", "--url", url, "--mail-from", address(from), ...recipients.flatMap((r) => ["--mail-rcpt", r]), "--upload-file", "-"];
    await transport(args, mime, `${config.username}:${config.password}`);
};
