import { simpleParser } from "mailparser";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalsDir, buildMessage, curlLogin, deliver, draftDigest, prepareApproval, sendRule, withCurlLogin } from "./send.js";

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
        expect(item.instructions).toContain(`imap send`);
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
    await deliver({ host: "smtp.example.org", port: 465, security: "tls", username: "sender@example.org", credential: { password: "secret" } }, "sender@example.org", { to: ["reader@example.org"], subject: "Hello", text: "Body" }, transport);
    expect(calls[0]).toContain("smtps://smtp.example.org:465");
    expect(calls[0]).toContain("--ssl-reqd");
    // The password travels beside the arguments, never in them, so the process list cannot show it.
    expect(calls[0]!.join(" ")).not.toContain("secret");
    expect(secrets[0]).toBe('user = "sender@example.org:secret"\n');
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

test("HTML mail includes plain text and HTML alternatives, including under mixed attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "imap-html-"));
    try {
        const file = join(root, "report.txt");
        await writeFile(file, "report");
        const draft = { to: ["reader@example.org"], subject: "Wniosek", text: "Plain office reply", html: "<p>Office reply</p>" };
        for (const attachments of [[], [{ path: file }]]) {
            const parsed = await simpleParser(await buildMessage("sender@example.org", { ...draft, attachments }));
            expect(parsed.text?.trim()).toBe(draft.text);
            expect(String(parsed.html).trim()).toBe(draft.html);
            expect(parsed.attachments.length).toBe(attachments.length);
        }
        expect(await draftDigest(draft)).not.toBe(await draftDigest({ ...draft, html: "<p>Changed</p>" }));
    } finally {await rm(root, { recursive: true, force: true });}
});
test("an OAuth2 send logs in with XOAUTH2 from the curl config, never the command line, and still holds by default", async () => {
    const argsSeen: string[][] = [];
    const logins: string[] = [];
    await deliver(
        { host: "smtp.office365.com", port: 587, security: "starttls", username: "office@example.org", credential: { accessToken: "smtp-oauth-secret" } },
        "office@example.org",
        { to: ["reader@example.org"], subject: "Reply", text: "Body" },
        async (args, _mime, login) => {
            argsSeen.push(args);
            logins.push(login);
        },
    );
    expect(argsSeen[0]!.join(" ")).not.toContain("smtp-oauth-secret");
    expect(logins[0]).toBe('user = "office@example.org:"\noauth2-bearer = "smtp-oauth-secret"\nlogin-options = "AUTH=XOAUTH2"\n');
    expect(sendRule(undefined)).toBe("hold");
    await expect(deliver({ host: "smtp.office365.com", port: 587, security: "starttls", username: "u@example.org", credential: { accessToken: "" } }, "u@example.org", { to: ["r@example.org"], subject: "s", text: "t" })).rejects.toThrow("incomplete");
});

test("the curl login file is 0600 and gone once curl is done", async () => {
    let seen = "";
    let mode = 0;
    await withCurlLogin(curlLogin("me@example.org", { password: "p@ss \"quoted\"" }), async (path) => {
        seen = await readFile(path, "utf8");
        mode = (await stat(path)).mode & 0o777;
    });
    expect(seen).toBe('user = "me@example.org:p@ss \\"quoted\\""\n');
    expect(mode).toBe(0o600);
});
