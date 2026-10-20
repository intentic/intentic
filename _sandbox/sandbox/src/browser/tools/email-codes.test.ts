import { decodeQuotedPrintable, extractCodes, fetchEmailCode, type ImapRead, extractLinks, imapSince, mailboxOf, matchesSite, parseSearch, siteToken } from "./email-codes.js";

// Pure parsing and extraction logic between the curl transport and the tool's answer; no network, no mocks needed.

// What counts as the site

test("siteToken reduces a host to the site's own name", () => {
    expect(siteToken("www.reddit.com")).toBe("reddit");
    expect(siteToken("https://accounts.google.com/signin")).toBe("google");
    expect(siteToken("x.com")).toBe("x");
    // A platform slug (no dots) is already the name.
    expect(siteToken("reddit")).toBe("reddit");
});

test("a mail matches on sender or subject, never on body", () => {
    // Common real shape: the sender's domain is a sibling of the site's, not the site itself.
    expect(matchesSite("Reddit <noreply@redditmail.com>", "Verify your email", "reddit")).toBe(true);
    expect(matchesSite("noreply@example.com", "Your Reddit verification code", "reddit")).toBe(true);
    // A digest about the site isn't mail from it; body mentions don't count (no body param).
    expect(matchesSite("digest@newsletter.com", "This week online", "reddit")).toBe(false);
});

// The wire parsers

test("parseSearch reads UIDs off the SEARCH response and nothing else", () => {
    expect(parseSearch("* SEARCH 101 103 208\r\n")).toEqual([101, 103, 208]);
    expect(parseSearch("* SEARCH\r\n")).toEqual([]);
    // Other untagged lines (a server greeting, an EXISTS) carry numbers that aren't UIDs.
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

// The extractors

test("subject codes come first, and a sentence-ending full stop is not a disqualifier", () => {
    const codes = extractCodes("483920 is your Reddit code", "Or use the code 771234.");
    // The subject's own digits are the commonest real shape ("NNNNNN is your X code"), so they rank first.
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
    // Real verification links often live on a click-tracking domain; the words in the path are the tell.
    expect(extractLinks("https://click.mailer.net/ls/verify?u=9", "reddit")).toEqual(["https://click.mailer.net/ls/verify?u=9"]);
});

// The linked entry as a mailbox

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

// Waiting for the code: a fake mailbox behind the same IMAP reads curl makes, so the timing is the code's own.

interface FakeMail {
    readonly from: string;
    readonly subject: string;
    readonly date: Date;
    readonly body: string;
}

const fakeMailbox = (initial: Record<number, FakeMail>) => {
    const mails = new Map(Object.entries(initial).map(([uid, mail]) => [Number(uid), mail]));
    const searches: string[] = [];
    const read: ImapRead = async (path, command) => {
        if (command !== undefined) {
            searches.push(command);
            const uids = [...mails.keys()].toSorted((a, b) => a - b);
            const from = /UID (\d+):\*/.exec(command)?.[1];
            // `n:*` names the newest message even below n, as a real server answers.
            const named = from === undefined ? uids : uids.filter((uid) => uid >= Number(from));
            return `* SEARCH ${(named.length > 0 || from === undefined ? named : uids.slice(-1)).join(" ")}\r\n`;
        }
        const uid = Number(/UID=(\d+)/.exec(path)?.[1]);
        const mail = mails.get(uid);
        if (mail === undefined) {
            return "";
        }
        return path.includes("SECTION=HEADER") ? `From: ${mail.from}\r\nSubject: ${mail.subject}\r\nDate: ${mail.date.toUTCString()}\r\n` : mail.body;
    };
    return { read, searches, deliver: (uid: number, mail: FakeMail) => void mails.set(uid, mail) };
};

const box = { host: "imap.example.com", port: "993", username: "me", password: "pw", mailbox: "INBOX" };
const codeMail = (code: string, date: Date): FakeMail => ({ from: "Reddit <noreply@redditmail.com>", subject: `Your code ${code}`, date, body: `Your verification code is ${code}.` });

describe("fetchEmailCode waiting for the mail", () => {
    it("holds until a mail from the site arrives after the call, passing over the older code and other senders", async () => {
        const now = new Date();
        const mailbox = fakeMailbox({ 7: codeMail("111111", new Date(now.getTime() - 10 * 60_000)) });
        setTimeout(() => mailbox.deliver(8, { from: "news@example.com", subject: "Weekly 222222", date: new Date(), body: "" }), 30);
        setTimeout(() => mailbox.deliver(9, codeMail("333333", new Date())), 120);
        const found = await fetchEmailCode(box, "www.reddit.com", { now, waitMs: 5_000, pollMs: 20, read: mailbox.read });
        expect(found).toMatchObject({ arrived: "after-call", codes: ["333333"] });
        // Every search after the first asks only past the highest UID it had seen.
        expect(mailbox.searches.slice(1).every((search) => /^UID SEARCH UID (8|9|10):\*$/.test(search))).toBe(true);
    });

    it("answers at once with a mail that landed just before the call", async () => {
        const now = new Date();
        const mailbox = fakeMailbox({ 4: codeMail("444444", new Date(now.getTime() - 20_000)) });
        const started = performance.now();
        const found = await fetchEmailCode(box, "reddit", { now, waitMs: 5_000, pollMs: 20, read: mailbox.read });
        expect(found).toMatchObject({ arrived: "just-before", codes: ["444444"] });
        expect(performance.now() - started).toBeLessThan(500);
        expect(mailbox.searches).toHaveLength(1);
    });

    it("falls back to the newest in the window, said as older, when nothing new comes in time", async () => {
        const now = new Date();
        const mailbox = fakeMailbox({ 5: codeMail("555555", new Date(now.getTime() - 5 * 60_000)) });
        expect(await fetchEmailCode(box, "reddit", { now, waitMs: 100, pollMs: 20, read: mailbox.read })).toMatchObject({ arrived: "earlier", codes: ["555555"] });
        // Nothing older than the half-hour window, and nothing at all, is no answer.
        const stale = fakeMailbox({ 3: codeMail("999999", new Date(now.getTime() - 45 * 60_000)) });
        expect(await fetchEmailCode(box, "reddit", { now, waitMs: 50, pollMs: 20, read: stale.read })).toBeUndefined();
        expect(await fetchEmailCode(box, "reddit", { now, waitMs: 0, read: fakeMailbox({}).read })).toBeUndefined();
    });

    it("lets the turn stop the wait", async () => {
        const stop = new AbortController();
        setTimeout(() => stop.abort(), 50);
        const started = performance.now();
        expect(await fetchEmailCode(box, "reddit", { now: new Date(), waitMs: 60_000, pollMs: 1_000, signal: stop.signal, read: fakeMailbox({}).read })).toBeUndefined();
        expect(performance.now() - started).toBeLessThan(1_000);
    });
});
