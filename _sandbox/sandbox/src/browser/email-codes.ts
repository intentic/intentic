import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Capability } from "@intentic/sandbox-contract";

/* THE NARROW KEY TO A MAILBOX, "the newest code or confirmation link this site just sent", and nothing else.
 *
 * An identity may link a mailbox (IdentityConfigSchema.mailbox → a connected IMAP entry), and this is the only
 * thing the accounts tools do with it. The alternative, telling the agent, in prose, to go search whatever
 * inbox is connected, hands it the whole mailbox to find six digits, and is also less reliable: the prose
 * names one particular connection and rots when the owner connected a different one. Here the daemon does the
 * reading, over the same `curl imaps://` the IMAP connector's own skill teaches (curl is in every image; a
 * proper IMAP client library would be a dependency for one verb), and the MODEL sees only what it asked for:
 * sender, subject, the codes, the links.
 *
 * WHAT COUNTS AS "FROM THIS SITE": the mail's sender or subject carries the site's name, the registrable label
 * of the host the agent is stuck on ("reddit" of www.reddit.com). Loose on purpose: verification mail comes
 * from noreply@redditmail.com and friends, so matching the full host would miss the very mail this exists for.
 *
 * WHAT COUNTS AS "JUST": a half-hour window. IMAP's SINCE is day-granular, so the search over-fetches a day and
 * the Date headers narrow it, signup mail arrives in seconds, but a retried form and a slow relay deserve
 * room, and anything older is some other day's mail that would only mislead. */

const run = promisify(execFile);

export interface Mailbox {
    readonly host: string;
    readonly port: string;
    readonly username: string;
    readonly password: string;
    readonly mailbox: string;
}

// The linked entry as a mailbox, when it is one: a cli capability whose config carries IMAP's shape (the imap
// connector's fields). Undefined for anything else, the caller's "this identity links no readable mailbox".
export const mailboxOf = (capability: Capability | undefined): Mailbox | undefined => {
    if (capability?.kind !== "cli") {
        return undefined;
    }
    const config = capability.config as Record<string, string | undefined>;
    const host = config["host"];
    const username = config["username"];
    const password = config["password"];
    if (host === undefined || host === "" || username === undefined || username === "" || password === undefined || password === "") {
        return undefined;
    }
    return { host, port: config["port"] ?? "993", username, password, mailbox: config["mailbox"] ?? "INBOX" };
};

// The site's NAME out of a host or a platform slug: the registrable label, lowercased, "reddit" from
// "www.reddit.com", "x" from "x.com", the slug itself when that is all we have.
export const siteToken = (site: string): string => {
    const host =
        site
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .split("/")[0] ?? "";
    const labels = host.split(".").filter((label) => label !== "");
    return (labels.length >= 2 ? labels[labels.length - 2] : labels[0]) ?? site.toLowerCase();
};

// One fetched mail, already reduced to what the tool may say.
export interface MailMatch {
    readonly from: string;
    readonly subject: string;
    readonly date: Date | undefined;
    readonly codes: readonly string[];
    readonly links: readonly string[];
}

// `* SEARCH 101 103 108` → the UIDs, oldest-first as the server lists them.
export const parseSearch = (output: string): number[] =>
    output
        .split("\n")
        .filter((line) => line.trimStart().startsWith("* SEARCH"))
        .flatMap((line) => line.match(/\d+/g) ?? [])
        .map(Number)
        .filter((uid) => Number.isFinite(uid) && uid > 0);

// Quoted-printable, undone loosely: soft line breaks first (they split codes and URLs mid-token), then the
// =XX escapes. Loose because mail in the wild mislabels itself, decoding text that wasn't QP is harmless
// (bare "=" followed by non-hex stays put), while not decoding text that was loses the link.
export const decodeQuotedPrintable = (text: string): string =>
    text.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

const headerValue = (headers: string, name: string): string => {
    // Unfold first (RFC 5322 continuation lines), then find the field.
    const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
    const match = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
    return match?.[1]?.trim() ?? "";
};

/* Codes: 4-8 digit runs, ranked by whether the words around them say "code". Subject first, "123456 is your
 * Reddit code" is the common shape, then body digits that sit near code-words, then bare body digits. Kept
 * as an ordered, deduped list so the first entry is the best guess and a wrong guess still leaves the rest. */
const CODE_WORDS = /\b(code|verification|verify|confirm|one[- ]?time|otp|pin|passcode)\b/i;
// A run glued to more digits through -, /, : or . is a date, a price, an order number or a version, but a
// full stop ENDING the sentence ("your code is 483920.") is prose, so the dot only disqualifies when digits
// continue past it.
const digitRuns = (text: string): string[] => text.match(/(?<![\d/.:-])\d{4,8}(?![\d/:-])(?!\.\d)/g) ?? [];
export const extractCodes = (subject: string, body: string): string[] => {
    const near = (text: string): string[] =>
        digitRuns(text).filter((code) => {
            const at = text.indexOf(code);
            return CODE_WORDS.test(text.slice(Math.max(0, at - 120), at + code.length + 120));
        });
    return [...new Set([...digitRuns(subject), ...near(body), ...digitRuns(body)])];
};

/* Links: URLs that look like the mail's one job, confirmation-shaped words in the URL, or the site's own name
 * in its host, with the tracking noise (unsubscribe, preferences) dropped. Ordered and deduped like codes. */
const LINK_WORDS = /verif|confirm|activat|magic|onboard|welcome|signup|sign-up|register|auth|token|invite/i;
const LINK_NOISE = /unsubscribe|preferences|privacy|terms|support|help\./i;
export const extractLinks = (body: string, token: string): string[] => {
    const urls = body.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
    const cleaned = urls.map((url) => url.replace(/[.,;>)]+$/, "")).filter((url) => !LINK_NOISE.test(url));
    const confirming = cleaned.filter((url) => LINK_WORDS.test(url) || url.toLowerCase().includes(token));
    return [...new Set(confirming)];
};

// A mail is "from this site" when the site's name appears where the site would put it. From and subject only,
// a BODY mentioning "reddit" is how a digest about Reddit impersonates a mail from it.
export const matchesSite = (from: string, subject: string, token: string): boolean =>
    from.toLowerCase().includes(token) || subject.toLowerCase().includes(token);

// RFC 3501 SINCE date: day-granular, so start the search a day early and let Date headers do the narrowing.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const imapSince = (now: Date): string => {
    const start = new Date(now.getTime() - 24 * 3_600_000);
    return `${start.getUTCDate()}-${MONTHS[start.getUTCMonth()]}-${start.getUTCFullYear()}`;
};

const WINDOW_MS = 30 * 60_000;
// How many of the newest mails to actually read. A busy inbox gets constant mail; the one this tool wants
// arrived seconds ago, so a dozen from the top is plenty and keeps the worst case bounded.
const FETCH_LIMIT = 12;
const CURL_TIMEOUT_MS = 20_000;
// How much of a body to read: enough for any verification mail's text part, bounded so a newsletter with a
// megabyte of markup cannot stall the turn.
const BODY_BYTES = 16_384;

const curl = async (mailbox: Mailbox, path: string, command?: string): Promise<string> => {
    const args = [
        "-s",
        "--max-time",
        String(CURL_TIMEOUT_MS / 1000),
        "--user",
        `${mailbox.username}:${mailbox.password}`,
        "--url",
        `imaps://${mailbox.host}:${mailbox.port}/${path}`,
        ...(command === undefined ? [] : ["-X", command]),
    ];
    const { stdout } = await run("curl", args, { timeout: CURL_TIMEOUT_MS + 5_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
};

/* The whole verb: search the window, read the newest few, return the newest mail that is from the site,
 * reduced to sender, subject, codes and links. Undefined when nothing in the window matches (the tool's "no
 * mail from this site yet, wait a moment and try again, or re-request the code"). Throws on transport
 * failures (bad credentials, unreachable host), which the tool surfaces as its error text. */
export const fetchEmailCode = async (mailbox: Mailbox, site: string, now: Date): Promise<MailMatch | undefined> => {
    const token = siteToken(site);
    const uids = parseSearch(await curl(mailbox, mailbox.mailbox, `UID SEARCH SINCE ${imapSince(now)}`));
    const newest = uids.toSorted((a, b) => b - a).slice(0, FETCH_LIMIT);
    for (const uid of newest) {
        const headers = await curl(mailbox, `${mailbox.mailbox};UID=${uid};SECTION=HEADER`);
        const from = headerValue(headers, "From");
        const subject = headerValue(headers, "Subject");
        if (!matchesSite(from, subject, token)) {
            continue;
        }
        const dateHeader = headerValue(headers, "Date");
        const date = dateHeader === "" ? undefined : new Date(dateHeader);
        if (date !== undefined && !Number.isNaN(date.getTime()) && now.getTime() - date.getTime() > WINDOW_MS) {
            // UIDs are allocation-ordered, so the first matching mail already outside the window means every
            // older one is too, the site has sent nothing recent.
            return undefined;
        }
        const body = decodeQuotedPrintable(await curl(mailbox, `${mailbox.mailbox};UID=${uid};SECTION=TEXT;PARTIAL=0-${BODY_BYTES}`));
        return {
            from,
            subject,
            date: date !== undefined && Number.isNaN(date.getTime()) ? undefined : date,
            codes: extractCodes(subject, body),
            links: extractLinks(body, token),
        };
    }
    return undefined;
};
