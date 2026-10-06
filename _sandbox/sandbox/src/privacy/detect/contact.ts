import { afterEscape, digitsOf, type Emit, isDigit, isWordChar, jsonKeyWordsBefore, keywordBefore } from "./text.js";

// E-mail addresses and phone numbers.

const LOCAL_CHAR = /[\p{L}\p{N}._%+-]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}.-]/u;
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const TLD = /^\p{L}{2,24}$/u;

// Mailboxes that belong to no one: bounce and no-reply senders, and the user part of ssh remotes (git@github.com).
const IMPERSONAL_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|git)(?:[-_+.].*)?$/i;
// The role mailboxes a company or a team answers (support@, kontakt@, security@), which name a function, not a person.
// Only as the whole name, or with a +tag: "admin.kowalski@…" is somebody's.
const ROLE_LOCAL =
    /^(?:support|help|helpdesk|info|contact|hello|sales|team|admin|administrator|root|hostmaster|webmaster|security|privacy|abuse|billing|careers|jobs|press|legal|office|biuro|kontakt|pomoc|sekretariat|notifications?|alerts?|bots?|agents?|ci|builds?|deploy|feedback|newsletter|marketing|partners|service|orders|invoices|faktury)(?:\+.*)?$/i;
// GitHub's privacy addresses, the domains reserved for examples (RFC 2606's example.com and its kin in other
// countries), and the names that never resolve on the internet: the reserved .test, .example, .invalid and .localhost
// (RFC 2606), mDNS's .local, and the private-use .internal, .lan and home.arpa (host.docker.internal).
// The placeholder domains documentation writes instead (your company, acme, foo) are no one's either.
const IMPERSONAL_DOMAIN =
    /(?:^|\.)(?:noreply\.github\.com|example\.\p{L}{2,}(?:\.\p{L}{2,})?|[^.]+\.(?:test|example|invalid|localhost|local|internal|lan)|home\.arpa|(?:your-?)?(?:company|domain|org|email|site|website)\.(?:com|org|net|io)|acme\.\p{L}{2,}|(?:foo|bar|foobar|baz)\.(?:com|org|net|io))$/iu;

// Whether a mailbox belongs to no one: then neither it nor a display name before it ("CI <ci@…>") is anyone's.
const impersonal = (local: string, domain: string): boolean =>
    IMPERSONAL_LOCAL.test(local) || ROLE_LOCAL.test(local) || IMPERSONAL_DOMAIN.test(domain);

const AT_SIGN = /@|%40|\\u0040/iu;

// The same for an address written whole.
export const impersonalAddress = (address: string): boolean => {
    const at = AT_SIGN.exec(address);
    return at !== null && impersonal(address.slice(0, at.index), address.slice(at.index + at[0].length));
};

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
// The @ as a URL encodes it (`%40`, a query string) and as a JSON escape writes it (`\u0040`).
const AT_SIGNS = /@|%40|\\u0040/giu;

const nextAt = (text: string, from: number): { readonly at: number; readonly length: number } | undefined => {
    AT_SIGNS.lastIndex = from;
    const found = AT_SIGNS.exec(text);
    return found === null ? undefined : { at: found.index, length: found[0].length };
};

export const findEmails = (text: string, emit: Emit): void => {
    for (let sign = nextAt(text, 0); sign !== undefined; ) {
        const { at } = sign;
        let start = at;
        // Back to the first character that can't be in a mailbox name, or to an escape's letter (`\njan@…` in raw JSON).
        while (start > 0 && at - start < 64 && LOCAL_CHAR.test(text[start - 1] ?? "") && !afterEscape(text, start)) {
            start -= 1;
        }
        while (start < at && text[start] === ".") {
            start += 1;
        }
        const after = at + sign.length;
        let end = after;
        while (end < text.length && end - at < 254 && DOMAIN_CHAR.test(text[end] ?? "")) {
            end += 1;
        }
        while (end > after && (text[end - 1] === "." || text[end - 1] === "-")) {
            end -= 1;
        }
        const local = text.slice(start, at);
        const domain = text.slice(after, end);
        if (local !== "" && validDomain(domain) && !impersonal(local, domain)) {
            emit(start, end, "email");
        }
        sign = nextAt(text, Math.max(at + 1, end));
    }
};

// A run of digits joined by at most two separator characters, with an optional leading "+", "(" or "(+". Taken whole and
// judged by its grouping, so a phone number is never found inside a longer run (an account number, a table row of
// figures) and a date, a time or a version (other separators) never forms one.
const DIGIT_RUN = /(?:\(?\+|\()?\d(?:[ .()-]{0,2}\d)*\)?/g;
const PHONE_KEYWORD = /(?<!\p{L})(?:tel|telefon\p{L}*|phone|mobile|mob|cell|kom|komórk\p{L}*|gsm|fax|faks)(?!\p{L})/iu;
// The words of a JSON key that name a phone: `mobileNumber`, `contact_phone`, `telefonKomorkowy`.
const PHONE_KEY_WORD = /^(?:tel|telefon\p{L}*|phone|telephone|mobile|mob|cell|cellphone|kom|komórk\p{L}*|komork\p{L}*|gsm|fax|faks|msisdn)$/u;
// "123 456 789 zł": Polish writes thousands with spaces, so a 3-3-3 amount looks like a mobile number.
const AMOUNT_AFTER = /^\s?(?:zł|zl|pln|eur|usd|gbp|chf|€|\$|£|%|km|kg|osób|os\.|szt|sztuk|b|kb|mb|gb|bytes|ms)(?!\p{L})/iu;
const AMOUNT_BEFORE = /[$€£]\s?$/u;

const sameSeparators = (separators: readonly string[], allowed: string): boolean =>
    separators.length > 0 && separators.every((separator) => separator === separators[0]) && allowed.includes(separators[0] ?? "x");

// Polish domestic formats: a mobile as 3-3-3, a landline as 2-3-2-2 or with its area code in brackets.
const domesticFormat = (run: string, groups: readonly string[], separators: readonly string[]): boolean => {
    const lengths = groups.map((group) => group.length).join(",");
    if (run.startsWith("(")) {
        // North American: the area code's three digits in brackets, then 3-4 (`(555) 123-4567`).
        if (/^\(\d{3}\) ?\d{3}-\d{4}$/.test(run)) {
            return true;
        }
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

// The lengths a number takes in the plans whose length is fixed, by country code: North America and Russia write 1 + 10
// and 7 + 10 digits, Poland 48 + 9. A millisecond timestamp with a plus before it is not a call to Wyoming.
const FIXED_LENGTH: ReadonlyArray<readonly [string, number]> = [
    ["1", 11],
    ["7", 11],
    ["48", 11],
];

// How a run is written can say it is no phone whatever its digits: an IPv4 address (four dotted groups, each at most
// 255), a separator of two characters other than a bracket's (the " -" of a diff stat's signed counts), or separators
// of two kinds. A bracketed area code and the gap after a country code may differ from the rest: a North American
// number written with "+1 (", a dashed one after "+1 ", a Polish landline with its area code as "(0-22)".
const notPhoneShaped = (run: string, separators: readonly string[]): boolean => {
    if (separators.some((separator) => separator.replaceAll(/[()]/g, "").length > 1)) {
        return true;
    }
    const afterBrackets = separators.slice(separators.findLastIndex((separator) => /[()]/.test(separator)) + 1);
    const counted = run.startsWith("+") && !run.includes("(") ? afterBrackets.slice(1) : afterBrackets;
    if (new Set(counted).size > 1) {
        return true;
    }
    const groups = run.replace(/^\(?\+?/, "").split(".");
    return groups.length === 4 && groups.every((group) => /^\d{1,3}$/.test(group) && Number(group) <= 255);
};

// A North American number no one can be called on: an area code starting with 0 or 1, which none does, or the 555
// exchange films and documentation use.
const fictionalNanp = (national: string): boolean => /^[01]/u.test(national) || national.slice(3, 6) === "555";

const isPhone = (text: string, run: string, start: number): boolean => {
    const digits = digitsOf(run);
    const separators = [...run.matchAll(/\d([ .()-]+)(?=\d)/g)].map((match) => match[1] ?? "");
    if (notPhoneShaped(run, separators)) {
        return false;
    }
    if (run.startsWith("+") || run.startsWith("(+")) {
        const fixed = FIXED_LENGTH.find(([code]) => digits.startsWith(code));
        if (digits.startsWith("1") && digits.length === 11 && fictionalNanp(digits.slice(1))) {
            return false;
        }
        return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") && (fixed === undefined || digits.length === fixed[1]);
    }
    if (/^\(\d{3}\)/u.test(run) && digits.length === 10 && fictionalNanp(digits)) {
        return false;
    }
    if (digits.startsWith("0048")) {
        return digits.length === 13;
    }
    // The trunk "0" of the old "(0-22) 123 45 67" is not part of the area code.
    const groups = run
        .split(/[ .()-]+/)
        .filter((group) => group !== "")
        .filter((group, index) => index > 0 || group !== "0");
    const amount =
        AMOUNT_AFTER.test(text.slice(start + run.length, start + run.length + 8)) || AMOUNT_BEFORE.test(text.slice(Math.max(0, start - 2), start));
    if (domesticFormat(run, groups, separators)) {
        return !amount;
    }
    // Nine digits bare, or in a grouping no format above claims, are a number like any other unless something calls
    // them a phone.
    const national = digits.length === 9 || (digits.length === 11 && digits.startsWith("48"));
    const named = keywordBefore(text, start, PHONE_KEYWORD, 30) || jsonKeyWordsBefore(text, start).some((word) => PHONE_KEY_WORD.test(word));
    return national && !digits.startsWith("0") && named && !amount;
};

// What may follow a phone number: not a port, more of a dotted number, or the rest of a host name.
const PORT_OR_MORE = /^(?:[:.]\d|\.\p{L})/u;

export const findPhones = (text: string, emit: Emit): void => {
    for (const match of text.matchAll(DIGIT_RUN)) {
        let run = match[0];
        const start = match.index;
        // A closing bracket the run picked up without an opening one belongs to the text around it.
        if (run.endsWith(")") && !run.includes("(")) {
            run = run.slice(0, -1);
        }
        const before = text[start - 1];
        // Joined by a hyphen to a word or a number before it, a run is part of a slug, an id or a range.
        if (
            (isWordChar(before) && !afterEscape(text, start)) ||
            before === "+" ||
            before === "/" ||
            (before === "-" && isWordChar(text[start - 2]))
        ) {
            continue;
        }
        if (isWordChar(text[start + run.length]) || run.replace(/[^()]/g, "").length % 2 === 1 || PORT_OR_MORE.test(text.slice(start + run.length))) {
            continue;
        }
        // A port after a host's address, or the part of a time or a ratio after its colon.
        if (before === ":" && isDigit(text[start - 2])) {
            continue;
        }
        if (isPhone(text, run, start)) {
            emit(start, start + run.length, "phone");
        }
    }
};
