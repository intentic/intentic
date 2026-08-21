import { describe, expect, it } from "vitest";
import { type GmailMessage, addressOf, attachmentsOf, bodyText, nameOf, parseMessage, replySubject, stripHtml } from "./gmail-message.js";

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

const message = (payload: NonNullable<GmailMessage["payload"]>): GmailMessage => ({
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    payload,
});

describe("bodyText", () => {
    it("prefers the plain-text part", () => {
        expect(
            bodyText({
                mimeType: "multipart/alternative",
                parts: [
                    { mimeType: "text/plain", body: { data: b64("the plain one") } },
                    { mimeType: "text/html", body: { data: b64("<p>the html one</p>") } },
                ],
            }),
        ).toBe("the plain one");
    });

    /* Html-only is not an edge case: it is most machine-sent mail, which is most of what an inbox triage
     * command is pointed at. Returning nothing for it would make the tool useless on the mail people get most. */
    it("falls back to stripped html when there is no plain part", () => {
        expect(bodyText({ mimeType: "text/html", body: { data: b64("<h1>Invoice</h1><p>Due <b>today</b></p>") } })).toBe("Invoice\nDue today");
    });

    it("does not mistake an attached text file for the body", () => {
        expect(
            bodyText({
                mimeType: "multipart/mixed",
                parts: [
                    { mimeType: "text/plain", body: { data: b64("read the attachment") } },
                    { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("attached notes"), attachmentId: "a1" } },
                ],
            }),
        ).toBe("read the attachment");
    });

    it("reaches through nested multiparts", () => {
        expect(
            bodyText({
                mimeType: "multipart/mixed",
                parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("buried") } }] }],
            }),
        ).toBe("buried");
    });
});

describe("stripHtml", () => {
    it("drops script and style content entirely", () => {
        expect(stripHtml("<style>p{color:red}</style><script>alert(1)</script><p>kept</p>")).toBe("kept");
    });

    it("turns block ends into line breaks and unescapes the common entities", () => {
        expect(stripHtml("<p>one</p><p>two &amp; three</p>")).toBe("one\ntwo & three");
        expect(stripHtml("one<br>two")).toBe("one\ntwo");
    });

    // A paragraph end followed by a <br> is two breaks and reads as a paragraph gap; only a run of three or
    // more collapses, which is what keeps a newsletter's spacer markup from becoming a page of blank lines.
    it("keeps one blank line but never a run of them", () => {
        expect(stripHtml("<p>one</p><br>two")).toBe("one\n\ntwo");
        expect(stripHtml("<p>one</p><br><br><br>two")).toBe("one\n\ntwo");
    });
});

describe("attachmentsOf", () => {
    it("finds every part with a filename and a fetchable id", () => {
        expect(
            attachmentsOf({
                parts: [
                    { mimeType: "text/plain", body: { data: b64("hi") } },
                    { mimeType: "application/pdf", filename: "report.pdf", body: { attachmentId: "a1", size: 4096 } },
                    // Inline images carry a filename but no attachmentId when Gmail embeds the bytes.
                    { mimeType: "image/png", filename: "logo.png", body: { data: b64("x") } },
                ],
            }),
        ).toEqual([{ id: "a1", filename: "report.pdf", mimeType: "application/pdf", size: 4096 }]);
    });
});

describe("headers", () => {
    it("pulls an address and a display name out of a From header", () => {
        expect(addressOf('"Ana Ruiz" <ana@x.com>')).toBe("ana@x.com");
        expect(nameOf('"Ana Ruiz" <ana@x.com>')).toBe("Ana Ruiz");
        expect(nameOf("ana@x.com")).toBe("ana@x.com");
        expect(addressOf("ana@x.com")).toBe("ana@x.com");
    });

    it("finds a header whatever case it was sent in", () => {
        const parsed = parseMessage(message({ headers: [{ name: "subject", value: "Hello" }] }));
        expect(parsed.subject).toBe("Hello");
    });

    it("adds one Re: however many round trips a subject has been through", () => {
        expect(replySubject("Budget")).toBe("Re: Budget");
        expect(replySubject("Re: Budget")).toBe("Re: Budget");
        expect(replySubject("RE: Budget")).toBe("RE: Budget");
    });
});
