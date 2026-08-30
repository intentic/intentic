/* WHETHER A FILE ACTUALLY HOLDS A CREDENTIAL, the fact that `secrets.access` only guesses at from a path.
 *
 * The classifier next door (command-classes.ts) reads shell text, so the strongest thing it can honestly say
 * about `sed … ~/.npmrc` is "this names a file that USUALLY holds a token". Usually is not always, and the gap
 * is where the class earns its reputation: most `~/.npmrc` files are three lines of registry config, most
 * `.env` files in a monorepo are ports and feature flags, `~/.ssh/known_hosts` is a list of public keys, and a
 * file that does not exist reads nothing at all. A card raised over one of those is not a near miss, it is
 * noise, and noise is what teaches an owner to answer the card without reading it, which is precisely how a
 * real credential read gets waved through six weeks later.
 *
 * So the class is split in two. The path table says WHICH FILES ARE WORTH LOOKING AT; this says WHAT A
 * CREDENTIAL LOOKS LIKE once one has been opened. It lives here, beside that table, because the two halves are
 * one definition of the class and an enforcement point that has a filesystem should not have to invent the
 * second half for itself (guard/credential-files.ts is the sandbox's fs half; a caller with no filesystem, the
 * browser or the machine agent, simply never asks and the path stands on its name alone).
 *
 * PURE, over the file's own text: no fs, no path logic, nothing to configure. That keeps this package free of
 * a runtime the editor bundle cannot have, and keeps the rule testable as a table of strings.
 *
 * IT ANSWERS THE EASY DIRECTION WELL AND THE HARD ONE CONSERVATIVELY. Everything below is written to say YES
 * on anything credential-shaped, because a yes costs one card and a no costs the whole rule: the only use of
 * this answer is to REMOVE a class the path table already added, so a false yes leaves behavior exactly as it
 * was and a false no silently un-gates a real read.
 */

/* A KEY THAT NAMES A CREDENTIAL, AND ITS VALUE. Matched as a suffix of whatever the key is spelled as, because
 * these files say the same thing a dozen ways and only the last word carries the meaning: `NPM_TOKEN`,
 * `//registry.npmjs.org/:_authToken`, `"accessToken"`, `aws_secret_access_key`, `password =`.
 *
 * The three value arms are the three ways a value is quoted across the formats this ever sees: JSON's double
 * quotes, a shell-ish dotenv's single quotes, and an ini file's bare rest-of-line.
 *
 * THE SEPARATOR MAY NOT CROSS A LINE, which is the difference between reading a file and reading a soup: with
 * `\s*` around it, an empty `GITHUB_TOKEN=` borrows the NEXT line as its value, and a dotenv of nine blank
 * placeholders reads as eight credentials. Every format here puts a value on its key's own line. */
const CREDENTIAL_ASSIGNMENT =
    /(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|passwo?rd|passphrase|credentials?|secret|token|bearer)["']?[ \t]*[:=][ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"',;}\n]*))/gi;

/* A VALUE THAT IS NOT A CREDENTIAL EVEN THOUGH ITS KEY SAYS IT IS: the empty one, the one still holding the
 * template's own words, and the one deferring to an environment variable or a secret reference. Every dotenv
 * that ships in a repo is made of these, and firing on `GITHUB_TOKEN=${GITHUB_TOKEN}` would put a card in front
 * of reading a file whose entire content is the absence of a secret. */
const PLACEHOLDER =
    /^(?:\$\{?[\w:.-]+\}?|\{\{[^}]*\}\}|<[^>]*>|%\w+%|x{3,}|\*{3,}|\.{3,}|…|(?:your|my|our|the)[-_\s].*|change[-_]?me|replace[-_]?(?:me|this|with)|todo|tbd|fixme|none|null|nil|undefined|true|false|example|placeholder|redacted|dummy|sample|test|fake|secret|password|token|value|here)$/i;

/* Shorter than any credential a service actually issues. It clears the dev-compose defaults an agent reads all
 * day (`POSTGRES_PASSWORD=dev`, `password=x`), which are not what a card asking about credential material is
 * for, and it is well under the shortest real token below (a 36-character npm one). */
const MIN_VALUE = 6;

/* A CREDENTIAL RECOGNISABLE WITHOUT ITS KEY: the issuers whose tokens carry their own prefix, the PEM and PuTTY
 * headers that ARE the private key file, and a URL that carries a password in its userinfo (which is the whole
 * content of `.git-credentials`, and the shape a `DATABASE_URL` hides one in).
 *
 * These are checked first and independently of any key, because half of these files have no `key = value` in
 * them at all. */
const TOKEN_SHAPES = [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
    /PuTTY-User-Key-File-\d/,
    // scheme://user:password@host — the password is the point; a Sentry DSN (`https://key@host`) has no colon
    // before the `@` and is deliberately not this.
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i,
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
    // A JWT: three base64url segments, the first two of which decode from `{"` and so always begin `ey`.
    /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\./,
];

/* A VALUE DEFERRED TO SOMEWHERE ELSE, removed before anything is read, because it is not one value but two
 * things to get wrong. `STRIPE_SECRET={{secret:STRIPE}}` holds no credential — that is the platform's own
 * convention for a file that must not hold one — and yet it reads as a credential twice over: the outer
 * assignment has a substantial-looking value, and the reference's own `secret:STRIPE` is a second `key: value`
 * inside it. Cutting them out first is simpler and steadier than teaching the value patterns to survive them. */
const DEFERRED_VALUE = /\{\{[^}\n]*\}\}|\$\{[^}\n]*\}/g;

// Does this file's text hold something worth a card? Handed the WHOLE file by its caller, which is why the
// caller (not this) is the one that decides how much of a large file is worth reading.
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
