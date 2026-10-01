import { digitsOf, type Emit, isDigit, isWordChar, keywordBefore } from "./text.js";

// E-mail addresses and phone numbers.

const LOCAL_CHAR = /[\p{L}\p{N}._%+-]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}.-]/u;
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const TLD = /^\p{L}{2,24}$/u;

// Mailboxes that belong to no one: bounce and no-reply senders, and the user part of ssh remotes (git@github.com).
const IMPERSONAL_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|git)(?:[-_+.].*)?$/i;
// GitHub's privacy addresses, and the domains reserved for examples (RFC 2606).
const IMPERSONAL_DOMAIN = /(?:^|\.)(?:noreply\.github\.com|example\.(?:com|org|net))$/i;
// "icon@2x.png" and "lib@1.2.3.js" have an address's shape; a file extension is not a top-level domain.
const FILE_EXTENSIONS = new Set(
    "png jpg jpeg gif svg webp avif ico bmp tif tiff js mjs cjs ts mts cts tsx jsx css scss sass less json md mdx html htm txt yaml yml toml lock map wasm vue svelte py rb go rs java kt php sh zip gz tar pdf csv xml patch diff log".split(
        " ",
    ),
);

// A domain of numbers before its last label is a version ("mermaid@12.0.0.patch"), not a host.
const validDomain = (domain: string): boolean => {
    const labels = domain.split(".");
    const tld = labels.at(-1) ?? "";
    const named = labels.slice(0, -1).some((label) => /\p{L}/u.test(label));
    return labels.length >= 2 && named && labels.every((label) => LABEL.test(label)) && TLD.test(tld) && !FILE_EXTENSIONS.has(tld.toLowerCase());
};

// Scanned outward from each "@" rather than matched with one pattern: a pattern for the part before the "@" would be
// retried at every character of every long word, and an "@" is rare.
export const findEmails = (text: string, emit: Emit): void => {
    let at = text.indexOf("@");
    while (at !== -1) {
        let start = at;
        while (start > 0 && at - start < 64 && LOCAL_CHAR.test(text[start - 1] ?? "")) {
            start -= 1;
        }
        while (start < at && text[start] === ".") {
            start += 1;
        }
        let end = at + 1;
        while (end < text.length && end - at < 254 && DOMAIN_CHAR.test(text[end] ?? "")) {
            end += 1;
        }
        while (end > at + 1 && (text[end - 1] === "." || text[end - 1] === "-")) {
            end -= 1;
        }
        const local = text.slice(start, at);
        const domain = text.slice(at + 1, end);
        if (local !== "" && validDomain(domain) && !IMPERSONAL_LOCAL.test(local) && !IMPERSONAL_DOMAIN.test(domain)) {
            emit(start, end, "email");
        }
        at = text.indexOf("@", Math.max(at + 1, end));
    }
};

// A run of digits joined by at most two separator characters, with an optional leading "+", "(" or "(+". Taken whole and
// judged by its grouping, so a phone number is never found inside a longer run (an account number, a table row of
// figures) and a date, a time or a version (other separators) never forms one.
const DIGIT_RUN = /(?:\(?\+|\()?\d(?:[ .()-]{0,2}\d)*\)?/g;
const PHONE_KEYWORD = /(?<!\p{L})(?:tel|telefon\p{L}*|phone|mobile|mob|cell|kom|komórk\p{L}*|gsm|fax|faks)(?!\p{L})/iu;
// "123 456 789 zł": Polish writes thousands with spaces, so a 3-3-3 amount looks like a mobile number.
const AMOUNT_AFTER = /^\s?(?:zł|zl|pln|eur|usd|gbp|chf|€|\$|£|%|km|kg|osób|os\.|szt|sztuk|b|kb|mb|gb|bytes|ms)(?!\p{L})/iu;
const AMOUNT_BEFORE = /[$€£]\s?$/u;

const sameSeparators = (separators: readonly string[], allowed: string): boolean =>
    separators.length > 0 && separators.every((separator) => separator === separators[0]) && allowed.includes(separators[0] ?? "x");

// Polish domestic formats: a mobile as 3-3-3, a landline as 2-3-2-2 or with its area code in brackets.
const domesticFormat = (run: string, groups: readonly string[], separators: readonly string[]): boolean => {
    const lengths = groups.map((group) => group.length).join(",");
    if (run.startsWith("(")) {
        return /^\((?:0[ -]?)?\d{2}\)/.test(run) && (lengths === "2,3,2,2" || lengths === "2,7" || lengths === "2,3,4");
    }
    if (run.startsWith("0") || separators.some((separator) => separator.includes("."))) {
        return false;
    }
    // Spaced 3-3-3 is also how lists of small numbers print ("SEARCH 101 103 208"): only a mobile prefix (4-9) makes
    // it a phone. Dashed, any number is.
    const mobile = lengths === "3,3,3" && (separators[0] === "-" || /^[4-9]/.test(run));
    return (mobile || lengths === "2,3,2,2") && sameSeparators(separators, " -");
};

const isPhone = (text: string, run: string, start: number): boolean => {
    const digits = digitsOf(run);
    if (run.startsWith("+") || run.startsWith("(+")) {
        return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0");
    }
    if (digits.startsWith("0048")) {
        return digits.length === 13;
    }
    // The trunk "0" of the old "(0-22) 123 45 67" is not part of the area code.
    const groups = run
        .split(/[ .()-]+/)
        .filter((group) => group !== "")
        .filter((group, index) => index > 0 || group !== "0");
    const separators = [...run.matchAll(/\d([ .()-]+)(?=\d)/g)].map((match) => match[1] ?? "");
    if (domesticFormat(run, groups, separators)) {
        return (
            !AMOUNT_AFTER.test(text.slice(start + run.length, start + run.length + 8)) &&
            !AMOUNT_BEFORE.test(text.slice(Math.max(0, start - 2), start))
        );
    }
    // Nine digits bare, or in a grouping no format above claims, are a number like any other unless something calls
    // them a phone.
    const national = digits.length === 9 || (digits.length === 11 && digits.startsWith("48"));
    return national && !digits.startsWith("0") && keywordBefore(text, start, PHONE_KEYWORD, 30);
};

export const findPhones = (text: string, emit: Emit): void => {
    for (const match of text.matchAll(DIGIT_RUN)) {
        let run = match[0];
        const start = match.index;
        // A closing bracket the run picked up without an opening one belongs to the text around it.
        if (run.endsWith(")") && !run.includes("(")) {
            run = run.slice(0, -1);
        }
        const before = text[start - 1];
        if (isWordChar(before) || before === "+" || before === "/" || (before === "-" && isDigit(text[start - 2]))) {
            continue;
        }
        if (isWordChar(text[start + run.length]) || run.replace(/[^()]/g, "").length % 2 === 1) {
            continue;
        }
        if (isPhone(text, run, start)) {
            emit(start, start + run.length, "phone");
        }
    }
};
