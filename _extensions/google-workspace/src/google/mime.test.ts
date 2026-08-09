import { describe, expect, it } from "vitest";
import { buildMessage, contentTypeOf, encodeHeader, encodeRaw } from "./mime.js";

const decodeBody = (message: string): string => {
    const [, body = ""] = message.split("\r\n\r\n");
    return Buffer.from(body.replaceAll("\r\n", ""), "base64").toString("utf8");
};

describe("encodeHeader", () => {
    it("leaves plain ASCII alone — an encoded word where none is needed makes every subject unreadable raw", () => {
        expect(encodeHeader("Q3 numbers")).toBe("Q3 numbers");
    });

    // Without this an em dash or an accent reaches the recipient as mojibake.
    it("encodes anything outside ASCII per RFC 2047", () => {
        expect(encodeHeader("Résumé — final")).toBe(`=?UTF-8?B?${Buffer.from("Résumé — final", "utf8").toString("base64")}?=`);
    });
});

describe("buildMessage", () => {
    it("writes the addressing headers and a base64 body", () => {
        const message = buildMessage({ to: ["a@x.com", "b@y.com"], cc: ["c@z.com"], subject: "Hi", body: "hello there" }, "seed");
        expect(message).toContain("To: a@x.com, b@y.com");
        expect(message).toContain("Cc: c@z.com");
        expect(message).toContain("Subject: Hi");
        expect(message).toContain("Content-Type: text/plain; charset=UTF-8");
        expect(decodeBody(message)).toBe("hello there");
    });

    it("omits Cc, Bcc and From when there are none, rather than sending them empty", () => {
        const message = buildMessage({ to: ["a@x.com"], cc: [], bcc: [], subject: "Hi", body: "x" }, "seed");
        expect(message).not.toContain("Cc:");
        expect(message).not.toContain("Bcc:");
        expect(message).not.toContain("From:");
    });

    it("carries the threading headers a reply needs", () => {
        const message = buildMessage(
            { to: ["a@x.com"], subject: "Re: Hi", body: "x", headers: { "In-Reply-To": "<abc@mail>", References: "<abc@mail>" } },
            "seed",
        );
        expect(message).toContain("In-Reply-To: <abc@mail>");
        expect(message).toContain("References: <abc@mail>");
    });

    it("becomes multipart/mixed with a part per attachment", () => {
        const message = buildMessage(
            {
                to: ["a@x.com"],
                subject: "Report",
                body: "attached",
                attachments: [{ filename: "report.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4") }],
            },
            "seed",
        );
        expect(message).toContain('Content-Type: multipart/mixed; boundary="gw-seed"');
        expect(message).toContain('Content-Disposition: attachment; filename="report.pdf"');
        expect(message).toContain(Buffer.from("%PDF-1.4").toString("base64"));
        expect(message.trimEnd().endsWith("--gw-seed--")).toBe(true);
    });

    // Base64 lines must wrap at 76 columns; a body that is one long URL is exactly where a hand-rolled
    // encoder produces a line no mail server will accept.
    it("wraps the encoded body so no line runs past 76 characters", () => {
        const message = buildMessage({ to: ["a@x.com"], subject: "Long", body: "x".repeat(5000) }, "seed");
        expect(message.split("\r\n").every((line) => line.length <= 76)).toBe(true);
    });

    it("encodes the whole message the way Gmail's raw field takes it", () => {
        expect(Buffer.from(encodeRaw("A: b\r\n\r\nc"), "base64url").toString("utf8")).toBe("A: b\r\n\r\nc");
    });
});

describe("contentTypeOf", () => {
    it("names the formats people attach, and falls back to bytes for the rest", () => {
        expect(contentTypeOf("report.pdf")).toBe("application/pdf");
        expect(contentTypeOf("SHEET.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        expect(contentTypeOf("archive.tar.zst")).toBe("application/octet-stream");
        expect(contentTypeOf("noextension")).toBe("application/octet-stream");
    });
});
