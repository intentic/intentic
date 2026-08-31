import { expect, test } from "vitest";
import { attachmentsOf, excerptOf, expungeMessage, flagsMessage, htmlText, mailMessage } from "./normalize.js";

const base = {
    capabilityId: "work",
    username: "me@example.com",
    mailbox: "INBOX",
    uidValidity: "111",
    uid: 7,
    envelope: {
        subject: "Hello",
        messageId: "<abc@mail>",
        from: [{ name: "Alice", address: "alice@example.com" }],
        to: [{ address: "ME@example.com" }],
        cc: [{ address: "bob@example.com" }],
    },
    internalDate: new Date("2026-07-17T10:00:00Z"),
    bodyStructure: undefined,
    text: "Hi there",
};

test("mailMessage maps an email to the listener envelope", () => {
    expect(mailMessage(base)).toEqual({
        provider: "imap",
        type: "message",
        id: "work:111:7",
        channelId: "INBOX",
        author: { id: "alice@example.com", name: "Alice" },
        content: "Subject: Hello\n\nHi there",
        mentioned: true,
        timestamp: "2026-07-17T10:00:00.000Z",
        extra: { capabilityId: "work", uid: 7, messageId: "<abc@mail>", to: ["ME@example.com"], cc: ["bob@example.com"] },
    });
});

test("mentioned only when the account address is in To: cc-only mail and host-style logins never set it", () => {
    const ccOnly = mailMessage({ ...base, envelope: { ...base.envelope, to: [{ address: "other@example.com" }] } });
    expect(ccOnly).not.toHaveProperty("mentioned");
    const hostLogin = mailMessage({ ...base, username: "me" });
    expect(hostLogin).not.toHaveProperty("mentioned");
});

test("author and subject degrade to placeholders on a bare envelope; no text ⇒ subject-only content", () => {
    const bare = mailMessage({ ...base, envelope: undefined, internalDate: undefined, text: undefined });
    expect(bare["author"]).toEqual({ id: "unknown", name: "unknown" });
    expect(bare["content"]).toBe("Subject: (no subject)");
    expect(Date.parse(bare["timestamp"] as string)).not.toBeNaN();
    const unnamed = mailMessage({ ...base, envelope: { from: [{ address: "a@b.c" }] } });
    expect(unnamed["author"]).toEqual({ id: "a@b.c", name: "a@b.c" });
});

test("content truncates the body excerpt", () => {
    const long = mailMessage({ ...base, text: "x".repeat(5000) });
    expect((long["content"] as string).length).toBeLessThan(4200);
    expect(long["content"]).toMatch(/…$/);
    expect(excerptOf("  short  ")).toBe("short");
});

test("htmlText strips tags, style and script bodies", () => {
    expect(htmlText("<style>a{color:red}</style><p>Hi&nbsp;<b>there</b></p><script>x()</script>")).toBe("Hi there");
});

test("attachmentsOf walks nested multiparts, keeping named and attachment-disposed leaves", () => {
    const structure = {
        type: "multipart/mixed",
        childNodes: [
            { type: "multipart/alternative", childNodes: [{ type: "text/plain" }, { type: "text/html" }] },
            { type: "application/pdf", size: 999, disposition: "attachment", dispositionParameters: { filename: "report.pdf" } },
            { type: "image/png", disposition: "inline", parameters: { name: "shot.png" } },
            { type: "application/octet-stream", disposition: "ATTACHMENT" },
        ],
    };
    expect(attachmentsOf(structure)).toEqual([
        { filename: "report.pdf", contentType: "application/pdf", size: 999 },
        { filename: "shot.png", contentType: "image/png" },
        { filename: "unnamed", contentType: "application/octet-stream" },
    ]);
    const mail = mailMessage({ ...base, bodyStructure: structure });
    expect((mail["extra"] as Record<string, unknown>)["attachments"]).toHaveLength(3);
});

test("flagsMessage reports the uid only when the server sent one", () => {
    const withUid = flagsMessage({ capabilityId: "work", username: "me", mailbox: "INBOX", uidValidity: "111", seq: 3, uid: 7, flags: ["\\Seen"] });
    expect(withUid["id"]).toMatch(/^work:111:flags:7:\d+$/);
    expect(withUid["content"]).toContain("INBOX");
    expect(withUid["content"]).toContain(String(withUid["extra"] && (withUid["extra"] as { uid: number }).uid));
    expect(withUid["content"]).toContain("\\Seen");
    expect(withUid["extra"]).toEqual({ capabilityId: "work", seq: 3, uid: 7, flags: ["\\Seen"] });
    expect(Date.parse(withUid["timestamp"] as string)).not.toBeNaN();

    const seqOnly = flagsMessage({ capabilityId: "work", username: "me", mailbox: "INBOX", uidValidity: "111", seq: 3, uid: undefined, flags: [] });
    expect(seqOnly["id"]).toMatch(/^work:111:flags:seq3:\d+$/);
    expect(seqOnly["content"]).toContain("INBOX");
    expect(seqOnly["content"]).toContain(String((seqOnly["extra"] as { seq: number }).seq));
    expect(seqOnly["content"]).not.toContain(String(7));
    expect(seqOnly["extra"]).toEqual({ capabilityId: "work", seq: 3, flags: [] });
    expect(withUid["content"]).not.toBe(seqOnly["content"]);
});

test("expungeMessage states exactly what the server reported", () => {
    const seqOnly = expungeMessage({
        capabilityId: "work",
        username: "me",
        mailbox: "INBOX",
        uidValidity: "111",
        seq: 4,
        uid: undefined,
        vanished: false,
    });
    expect(seqOnly["content"]).toContain("INBOX");
    expect(seqOnly["content"]).toContain(String((seqOnly["extra"] as { seq: number }).seq));
    expect(seqOnly["extra"]).toEqual({ capabilityId: "work", seq: 4, vanished: false });

    const vanished = expungeMessage({
        capabilityId: "work",
        username: "me",
        mailbox: "INBOX",
        uidValidity: "111",
        seq: undefined,
        uid: 9,
        vanished: true,
    });
    expect(vanished["content"]).toContain("INBOX");
    expect(vanished["content"]).toContain(String((vanished["extra"] as { uid: number }).uid));
    expect(vanished["extra"]).toEqual({ capabilityId: "work", uid: 9, vanished: true });
    expect(vanished["channelId"]).toBe("INBOX");
    expect(seqOnly["content"]).not.toBe(vanished["content"]);
});
