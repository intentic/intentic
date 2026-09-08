import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Capability } from "@intentic/sandbox-contract";

// Narrow mailbox key: the newest code or link a site sent; read over the curl imaps:// the IMAP skill teaches.
// "From this site" means sender or subject carries the site's label; loose, since verification comes from siblings.
// "Just" means a half-hour window: SINCE is day-granular, so the search over-fetches a day and the Date header narrows
// it.

const run = promisify(execFile);

export interface Mailbox {
    readonly host: string;
    readonly port: string;
    readonly username: string;
    readonly password: string;
    readonly mailbox: string;
}

// Linked entry as a mailbox, when it's a cli capability shaped like the IMAP connector's config; undefined otherwise
// (caller says "no readable mailbox").
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

// Site's registrable label, lowercased: "reddit" from "www.reddit.com" or "x.com"; the slug itself when that's all
// there is.
export const siteToken = (site: string): string => {
    const host =
        site
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .split("/")[0] ?? "";
    const labels = host.split(".").filter((label) => label !== "");
    return (labels.length >= 2 ? labels.at(-2) : labels[0]) ?? site.toLowerCase();
};

// One fetched mail, reduced to what the tool may say.
export interface MailMatch {
    readonly from: string;
    readonly subject: string;
    readonly date: Date | undefined;
    readonly codes: readonly string[];
    readonly links: readonly string[];
}

// `* SEARCH 101 103 108` to the UIDs, oldest-first as the server lists them.
export const parseSearch = (output: string): number[] =>
    output
        .split("\n")
        .filter((line) => line.trimStart().startsWith("* SEARCH"))
        .flatMap((line) => line.match(/\d+/g) ?? [])
        .map(Number)
        .filter((uid) => Number.isFinite(uid) && uid > 0);

// Undoes quoted-printable loosely: soft breaks first (they split tokens mid-word), then =XX escapes; a bare "=" before
// non-hex is left alone.
export const decodeQuotedPrintable = (text: string): string =>
    text.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

const headerValue = (headers: string, name: string): string => {
    // Unfolds RFC 5322 continuation lines first, then finds the field.
    const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
    const match = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
    return match?.[1]?.trim() ?? "";
};

// Codes rank subject digits first, then body digits near a code-word, then bare body digits; deduped, ordered.
const CODE_WORDS = /\b(code|verification|verify|confirm|one[- ]?time|otp|pin|passcode)\b/i;
// A run glued to more digits (-/:.) is a date, price or version; a sentence-ending full stop doesn't disqualify.
const digitRuns = (text: string): string[] => text.match(/(?<![\d/.:-])\d{4,8}(?![\d/:-])(?!\.\d)/g) ?? [];
export const extractCodes = (subject: string, body: string): string[] => {
    const near = (text: string): string[] =>
        digitRuns(text).filter((code) => {
            const at = text.indexOf(code);
            return CODE_WORDS.test(text.slice(Math.max(0, at - 120), at + code.length + 120));
        });
    return [...new Set([...digitRuns(subject), ...near(body), ...digitRuns(body)])];
};

// Confirmation-shaped words or the site's name in the host; tracking noise (unsubscribe, preferences) dropped.
const LINK_WORDS = /verif|confirm|activat|magic|onboard|welcome|signup|sign-up|register|auth|token|invite/i;
const LINK_NOISE = /unsubscribe|preferences|privacy|terms|support|help\./i;
export const extractLinks = (body: string, token: string): string[] => {
    const urls = body.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
    const cleaned = urls.map((url) => url.replace(/[.,;>)]+$/, "")).filter((url) => !LINK_NOISE.test(url));
    const confirming = cleaned.filter((url) => LINK_WORDS.test(url) || url.toLowerCase().includes(token));
    return [...new Set(confirming)];
};

// "From this site" means the name appears in From or Subject only; a body mention is how a digest impersonates real
// mail.
export const matchesSite = (from: string, subject: string, token: string): boolean =>
    from.toLowerCase().includes(token) || subject.toLowerCase().includes(token);

// RFC 3501 SINCE is day-granular; starts the search a day early and lets Date headers narrow it.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const imapSince = (now: Date): string => {
    const start = new Date(now.getTime() - 24 * 3_600_000);
    return `${start.getUTCDate()}-${MONTHS[start.getUTCMonth()]}-${start.getUTCFullYear()}`;
};

const WINDOW_MS = 30 * 60_000;
// How many newest mails to read; a dozen bounds the worst case since the wanted mail arrives within seconds.
const FETCH_LIMIT = 12;
const CURL_TIMEOUT_MS = 20_000;
// How much of a body to read: enough for verification text, bounded against a newsletter's megabyte of markup.
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

// Searches the window, reads the newest few, returns the first mail from the site or undefined if none match.
// Throws on transport failure (bad credentials, unreachable host), surfaced as the tool's error text.
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
            // UIDs are allocation-ordered: the first match outside the window means every older one is too.
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
