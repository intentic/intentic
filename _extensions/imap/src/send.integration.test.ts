import { simpleParser } from "mailparser";
import { readFile, stat } from "node:fs/promises";
import { cardFromConfig } from "./card.js";
import { runRequest } from "./request.js";
import { buildMessage, curlLogin, deliver, DeliveryError, mailDetails, withCurlLogin } from "./send.js";

const base64 = (text: string): string => Buffer.from(text).toString("base64");

test("message includes reply threading and encoded UTF-8 subject", () => {
    const mime = buildMessage("sender@example.org", {
        to: ["reader@example.org"], subject: "Odpowiedź", text: "Treść", inReplyTo: "<original@example.org>", references: ["<root@example.org>", "<original@example.org>"],
    }).toString();
    expect(mime).toContain("In-Reply-To: <original@example.org>\r\n");
    expect(mime).toContain("References: <root@example.org> <original@example.org>\r\n");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain(Buffer.from("Treść").toString("base64"));
});

test("an attachment's bytes are MIME encoded and header injection is refused", () => {
    const mime = buildMessage("sender@example.org", { to: ["reader@example.org"], subject: "Report", text: "Attached", attachments: [{ name: "report.txt", data: base64("file body") }] }).toString();
    expect(mime).toContain('Content-Disposition: attachment; filename="report.txt"');
    expect(mime).toContain(base64("file body"));
    expect(() => buildMessage("sender@example.org", { to: ["reader@example.org\r\nBcc: hidden@example.org"], subject: "x", text: "x" })).toThrow("newline in mail header");
    expect(() => buildMessage("sender@example.org", { to: ["reader@example.org"], subject: "x", text: "x", attachments: [{ name: 'a"b', data: "" }] })).toThrow("printable ASCII");
});

test("what the owner reads names every recipient, both bodies and each attachment by size", () => {
    const details = mailDetails("sender@example.org", {
        to: ["reader@example.org"],
        cc: ["copy@example.org"],
        subject: "Report",
        text: "Exact body",
        html: "<p>Exact body</p>",
        attachments: [{ name: "report.txt", data: base64("12345") }],
    });
    expect(details).toBe(
        "From: sender@example.org\nTo: reader@example.org\nCc: copy@example.org\nSubject: Report\n\nExact body\n\nHTML: <p>Exact body</p>\n\nAttachments: report.txt (5 bytes)",
    );
});

test("delivery hands the composed message to TLS SMTP with the login beside the arguments, never in them", async () => {
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

test("HTML mail includes plain text and HTML alternatives, including under mixed attachments", async () => {
    const draft = { to: ["reader@example.org"], subject: "Wniosek", text: "Plain office reply", html: "<p>Office reply</p>" };
    for (const attachments of [[], [{ name: "report.txt", data: base64("report") }]]) {
        const parsed = await simpleParser(buildMessage("sender@example.org", { ...draft, attachments }));
        expect(parsed.text?.trim()).toBe(draft.text);
        expect(String(parsed.html).trim()).toBe(draft.html);
        expect(parsed.attachments.length).toBe(attachments.length);
    }
});

test("an OAuth2 send logs in with XOAUTH2 from the curl config, never the command line", async () => {
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
    const incomplete = deliver({ host: "smtp.office365.com", port: 587, security: "starttls", username: "u@example.org", credential: { accessToken: "" } }, "u@example.org", { to: ["r@example.org"], subject: "s", text: "t" });
    await expect(incomplete).rejects.toThrow(new DeliveryError("SMTP connection is incomplete: set the SMTP host on the IMAP card", false));
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

test("an IMAP request's login rides a config file, never curl's arguments", async () => {
    const card = cardFromConfig("office", { host: "imap.example.org", port: "993", username: "me@example.org", password: "pw" });
    const seen: (readonly string[])[] = [];
    const answer = await runRequest(card, { password: "pw-secret" }, ["--url", "imaps://imap.example.org:993/"], async (args) => {
        seen.push(args);
        return { exitCode: 0, stdout: Buffer.from("* LIST"), stderr: "" };
    });
    expect(answer.stdout.toString()).toBe("* LIST");
    expect(seen[0]?.[0]).toBe("--config");
    expect(seen[0]?.join(" ")).not.toContain("pw-secret");
});
