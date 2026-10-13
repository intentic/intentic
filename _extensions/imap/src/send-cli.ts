import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findWorkspaceRoot } from "@intentic/connector-runtime";
import { approvalsDir, draftDigest, deliver, prepareApproval, sendRule, settingsFile, type MailDraft, type SmtpConfig } from "./send.js";

const main = async (): Promise<void> => {
    const root = findWorkspaceRoot(process.env, process.cwd());
    const draftFile = process.argv[2];
    if (!draftFile) {throw new Error("usage: node dist/send-cli.js <draft.json> [--approval-id <id>]");}
    // SAFETY: the draft is read from the local draft JSON supplied to this CLI; deliver validates recipients and headers.
    const draft = JSON.parse(await readFile(resolve(draftFile), "utf8")) as MailDraft;
    // SAFETY: only actionRules is consulted and sendRule treats missing or unrecognised values as hold.
    const settings = JSON.parse(await readFile(settingsFile(root), "utf8").catch(() => "{}")) as { actionRules?: Record<string, string> };
    const rule = sendRule(settings.actionRules);
    if (rule === "deny") {throw new Error("imap.message.send is denied by action rules");}
    const approvalId = process.argv[3] === "--approval-id" ? process.argv[4] : undefined;
    if (rule === "hold" && !approvalId) {
        const id = await prepareApproval(root, draft);
        process.stdout.write(`Prepared for approval: ${id}\n`);
        return;
    }
    if (approvalId) {
        if (!/^imap-send-[a-f0-9-]+$/.test(approvalId)) {throw new Error("invalid approval ID");}
        // SAFETY: status and instructions are checked below before this approval can authorize a send.
        const item = JSON.parse(await readFile(join(approvalsDir(root), `${approvalId}.json`), "utf8")) as { status?: string; instructions?: string };
        if (item.status !== "running" || !item.instructions?.includes(await draftDigest(draft))) {throw new Error("approval is not running for this exact draft");}
    }
    const config: SmtpConfig = {
        host: process.env["SMTP_HOST"] ?? "",
        port: Number(process.env["SMTP_PORT"] || "587"),
        security: process.env["SMTP_SECURITY"] === "tls" ? "tls" : "starttls",
        username: process.env["SMTP_USERNAME"] || process.env["IMAP_USERNAME"] || "",
        password: process.env["SMTP_PASSWORD"] || process.env["IMAP_PASSWORD"] || "",
    };
    await deliver(config, process.env["IMAP_USERNAME"] ?? config.username, draft);
    process.stdout.write("SMTP delivery accepted\n");
};

void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
