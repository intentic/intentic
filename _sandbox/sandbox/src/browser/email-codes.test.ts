import { expect, test } from "vitest";
import { decodeQuotedPrintable, extractCodes, extractLinks, imapSince, mailboxOf, matchesSite, parseSearch, siteToken } from "./email-codes.js";

/* The pure half of the narrow mailbox key: everything between the curl transport and the tool's answer. Held
 * because each rule here decides what the MODEL gets to see: a parser that over-reads hands it somebody's
 * newsletter, an extractor that under-reads loses the six digits this entire tool exists to fetch. */

// ── what counts as the site ─────────────────────────────────────────────────────────────────────────────────

test("siteToken reduces a host to the site's own name", () => {
    expect(siteToken("www.reddit.com")).toBe("reddit");
    expect(siteToken("https://accounts.google.com/signin")).toBe("google");
    expect(siteToken("x.com")).toBe("x");
    // A platform slug (no dots) is already the name.
    expect(siteToken("reddit")).toBe("reddit");
});

test("a mail matches on sender or subject, never on body", () => {
    // The common real shape: the sender's domain is a sibling of the site's, not the site itself.
    expect(matchesSite("Reddit <noreply@redditmail.com>", "Verify your email", "reddit")).toBe(true);
    expect(matchesSite("noreply@example.com", "Your Reddit verification code", "reddit")).toBe(true);
    // A digest ABOUT the site is not a mail FROM it: body mentions must not count, so there is no body param.
    expect(matchesSite("digest@newsletter.com", "This week online", "reddit")).toBe(false);
});

// ── the wire parsers ────────────────────────────────────────────────────────────────────────────────────────

test("parseSearch reads UIDs off the SEARCH response and nothing else", () => {
    expect(parseSearch("* SEARCH 101 103 208\r\n")).toEqual([101, 103, 208]);
    expect(parseSearch("* SEARCH\r\n")).toEqual([]);
    // Other untagged lines (a server greeting, an EXISTS) carry numbers that are not UIDs.
    expect(parseSearch("* 12 EXISTS\r\n* SEARCH 7\r\n")).toEqual([7]);
});

test("quoted-printable soft breaks are undone before extraction", () => {
    // A URL split across lines is the failure this decoder exists for: half a link is no link.
    expect(decodeQuotedPrintable("https://a.com/verify?t=3Dab=\r\ncd")).toBe("https://a.com/verify?t=abcd");
    // Text that was never QP survives: a bare "=" before non-hex stays as typed.
    expect(decodeQuotedPrintable("2+2=4 and a=b")).toBe("2+2=4 and a=b");
});

test("imapSince starts a day early in IMAP's own date shape", () => {
    // SINCE is day-granular; the Date headers narrow to the real window afterwards.
    expect(imapSince(new Date(Date.UTC(2026, 7, 10, 0, 10)))).toBe("9-Aug-2026");
});

// ── the extractors ──────────────────────────────────────────────────────────────────────────────────────────

test("subject codes come first, and a sentence-ending full stop is not a disqualifier", () => {
    const codes = extractCodes("483920 is your Reddit code", "Or use the code 771234.");
    // The subject's own digits are the commonest real shape ("NNNNNN is your X code") and rank first.
    expect(codes).toEqual(["483920", "771234"]);
});

test("codes never bleed out of dates, prices or version strings", () => {
    expect(extractCodes("", "posted on 2026/08/10, v1.2345.6, order #123-4567, at 12:3456")).toEqual([]);
});

test("links keep the confirmation, drop the tracking noise", () => {
    const body = [
        "Confirm: https://www.reddit.com/verification/abc123",
        "Manage: https://redditmail.com/unsubscribe/xyz",
        "Help: https://help.example.com/contact",
    ].join("\n");
    const links = extractLinks(body, "reddit");
    expect(links).toEqual(["https://www.reddit.com/verification/abc123"]);
});

test("a confirmation-shaped link on a foreign relay host still counts", () => {
    // Real verification links often live on a click-tracking domain: the WORDS in the path are the tell.
    expect(extractLinks("https://click.mailer.net/ls/verify?u=9", "reddit")).toEqual(["https://click.mailer.net/ls/verify?u=9"]);
});

// ── the linked entry as a mailbox ───────────────────────────────────────────────────────────────────────────

test("mailboxOf accepts exactly an IMAP-shaped cli entry", () => {
    const mailbox = mailboxOf({
        id: "imap",
        kind: "cli",
        config: { provider: "imap", host: "imap.gmail.com", username: "a@gmail.com", password: "app-pass" },
    });
    expect(mailbox).toEqual({ host: "imap.gmail.com", port: "993", username: "a@gmail.com", password: "app-pass", mailbox: "INBOX" });
    // A connector without credentials is not a mailbox the daemon can read.
    expect(mailboxOf({ id: "github", kind: "cli", config: { provider: "github", token: "t" } })).toBeUndefined();
    expect(mailboxOf(undefined)).toBeUndefined();
});
