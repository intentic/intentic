// Whether a file's text actually holds a credential, the fact command-classes.ts's path table can only guess at from a
// name. Pure over the text (no fs, no config), so it stays testable and works where there's no filesystem. Biased
// toward yes: a false positive costs one card, a false negative un-gates a real credential read.

// A key naming a credential (a suffix match) plus its value; the separator can't cross a line.
const CREDENTIAL_ASSIGNMENT =
    /(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|passwo?rd|passphrase|credentials?|secret|token|bearer)["']?[ \t]*[:=][ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"',;}\n]*))/gi;

// Values that aren't credentials despite the key: empty, a template, or deferring to an env var or reference.
const PLACEHOLDER =
    /^(?:\$\{?[\w:.-]+\}?|\{\{[^}]*\}\}|<[^>]*>|%\w+%|x{3,}|\*{3,}|\.{3,}|…|(?:your|my|our|the)[-_\s].*|change[-_]?me|replace[-_]?(?:me|this|with)|todo|tbd|fixme|none|null|nil|undefined|true|false|example|placeholder|redacted|dummy|sample|test|fake|secret|password|token|value|here)$/i;

// Shorter than any credential a service issues; clears dev-compose defaults like POSTGRES_PASSWORD=dev.
const MIN_VALUE = 6;

// Credentials recognisable without a key: issuer-prefixed tokens, PEM/PuTTY headers, a URL's userinfo password.
const STRUCTURAL_SHAPES = [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
    /PuTTY-User-Key-File-\d/,
    // scheme://user:password@host; a DSN's bare key@host (no colon) or an already-masked ***@ userinfo is excluded.
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:(?!\*+@)[^\s/@]{3,}@/i,
];

const ISSUED_TOKENS = [
    /\bnpm_[A-Za-z0-9]{30,}/,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
    /\bgithub_pat_[A-Za-z0-9_]{50,}/,
    /\bglpat-[A-Za-z0-9_-]{16,}/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
    /\bsk-[A-Za-z0-9_-]{20,}/,
    /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bASIA[0-9A-Z]{16}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bhf_[A-Za-z0-9]{30,}/,
    /\bdop_v1_[a-f0-9]{60,}/,
    // A JWT: three base64url segments, the first two of which decode from {" and so always begin "ey".
    /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\./,
];

const TOKEN_SHAPES = [...STRUCTURAL_SHAPES, ...ISSUED_TOKENS];

// Deferred references, stripped first: unstripped, each reads as a credential twice over.
const DEFERRED_VALUE = /\{\{[^}\n]*\}\}|\$\{[^}\n]*\}/g;

// Does this file's text hold something worth a card? Handed the whole file; the caller decides how much of a large one
// to read.
export const holdsCredentialMaterial = (file: string): boolean => {
    const text = file.replace(DEFERRED_VALUE, "");
    if (TOKEN_SHAPES.some((pattern) => pattern.test(text))) {
        return true;
    }
    for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
        const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        if (value.length >= MIN_VALUE && !PLACEHOLDER.test(value)) {
            return true;
        }
    }
    return false;
};

// Blunt because scoped to reads already known to be of a credential file; a .ppk body is the one known gap.
const MASK = "***";

// The g twins, built once: the tables above skip g since `test` wants none, but replace/replaceAll demands one.
const globally = (patterns: readonly RegExp[]): readonly RegExp[] => patterns.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));
const ISSUED_TOKENS_G = globally(ISSUED_TOKENS);
const CREDENTIAL_ASSIGNMENT_G = new RegExp(CREDENTIAL_ASSIGNMENT.source, CREDENTIAL_ASSIGNMENT.flags);

// The two shapes that mask to something else: a PEM keeps its header/footer, a URL keeps scheme, user and host.
const PRIVATE_KEY_BLOCK = /(-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----)[\s\S]*?(-----END \2PRIVATE KEY-----)/g;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)(?!\*+@)[^\s/@]{3,}@/gi;

// The truncated opener left once the bare-value arm stops at its first `}`, anchored at the start.
const DEFERRED_OPENER = /^(?:\{\{|\$)/;

export const maskCredentialMaterial = (text: string): string =>
    ISSUED_TOKENS_G.reduce((masked, token) => masked.replace(token, MASK), text)
        .replace(PRIVATE_KEY_BLOCK, `$1\n${MASK}\n$3`)
        .replace(URL_PASSWORD, `$1${MASK}@`)
        // Masks just the value, leaving key/separator/quoting readable; skips mirror the detector's own.
        .replace(CREDENTIAL_ASSIGNMENT_G, (match, ...groups: unknown[]) => {
            const value = (groups[0] ?? groups[1] ?? groups[2] ?? "") as string;
            const trimmed = value.trim();
            if (trimmed.length < MIN_VALUE || PLACEHOLDER.test(trimmed) || DEFERRED_OPENER.test(trimmed)) {
                return match;
            }
            // The value is the last thing matched, so its own text locates it inside the match without needing offsets.
            const at = match.lastIndexOf(value);
            return `${match.slice(0, at)}${MASK}${match.slice(at + value.length)}`;
        });
