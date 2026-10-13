import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsDir, buildMessage, deliver, draftDigest, prepareApproval, sendRule } from "./send.js";

test("message includes reply threading and encoded UTF-8 subject", async () => {
    const mime = (await buildMessage("sender@example.org", {
        to: ["reader@example.org"], subject: "Odpowiedź", text: "Treść", inReplyTo: "<original@example.org>", references: ["<root@example.org>", "<original@example.org>"],
    })).toString();
    expect(mime).toContain("In-Reply-To: <original@example.org>\r\n");
    expect(mime).toContain("References: <root@example.org> <original@example.org>\r\n");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain(Buffer.from("Treść").toString("base64"));
});

test("attachment is MIME encoded and header injection is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "imap-send-"));
    try {
        const path = join(root, "report.txt");
        await writeFile(path, "file body");
        const mime = (await buildMessage("sender@example.org", { to: ["reader@example.org"], subject: "Report", text: "Attached", attachments: [{ path }] })).toString();
        expect(mime).toContain('Content-Disposition: attachment; filename="report.txt"');
        expect(mime).toContain(Buffer.from("file body").toString("base64"));
        await expect(buildMessage("sender@example.org", { to: ["reader@example.org\r\nBcc: hidden@example.org"], subject: "x", text: "x" })).rejects.toThrow("newline in mail header");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("send gate holds by default, allows only an explicit allow, and queues an exact draft", async () => {
    expect(sendRule(undefined)).toBe("hold");
    expect(sendRule({ "imap.message.send": "allow" })).toBe("allow");
    expect(sendRule({ "imap.*": "allow", "imap.message.send": "deny" })).toBe("deny");
    const root = await mkdtemp(join(tmpdir(), "imap-approval-"));
    try {
        const id = await prepareApproval(root, { to: ["reader@example.org"], subject: "Hello", text: "Exact body" });
        const item = JSON.parse(await readFile(join(approvalsDir(root), `${id}.json`), "utf8"));
        expect(item.status).toBe("proposed");
        expect(item.details).toContain("Exact body");
        expect(item.instructions).toContain(`${id}.json`);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("explicit allow path hands the composed message to TLS SMTP transport", async () => {
    expect(sendRule({ "imap.message.send": "allow" })).toBe("allow");
    const calls: string[][] = [];
    const chunks: Buffer[] = [];
    const secrets: string[] = [];
    const transport = async (args: string[], mime: Buffer, credentials: string): Promise<void> => {
        calls.push(args);
        chunks.push(mime);
        secrets.push(credentials);
    };
    await deliver({ host: "smtp.example.org", port: 465, security: "tls", username: "sender@example.org", password: "secret" }, "sender@example.org", { to: ["reader@example.org"], subject: "Hello", text: "Body" }, transport);
    expect(calls[0]).toContain("smtps://smtp.example.org:465");
    expect(calls[0]).toContain("--ssl-reqd");
    // The password travels beside the arguments, never in them, so the process list cannot show it.
    expect(calls[0]!.join(" ")).not.toContain("secret");
    expect(secrets[0]).toBe("sender@example.org:secret");
    expect(Buffer.concat(chunks).toString()).toContain("To: reader@example.org\r\n");
});

test("approval digest covers attachment bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "imap-digest-"));
    try {
        const path = join(root, "report.txt");
        const draft = { to: ["reader@example.org"], subject: "Report", text: "See attached", attachments: [{ path }] };
        await writeFile(path, "first");
        const before = await draftDigest(draft);
        await writeFile(path, "changed");
        expect(await draftDigest(draft)).not.toBe(before);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
