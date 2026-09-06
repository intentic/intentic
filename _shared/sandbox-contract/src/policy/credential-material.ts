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
 * them at all.
 *
 * SPLIT IN TWO because the two halves are MASKED differently (maskCredentialMaterial below) though they DETECT
 * identically: a structural shape matches a header or an authority whose surroundings must survive the mask (a
 * PEM's body is the secret, not its `-----BEGIN` line; a URL's host is not the secret), and an issued token is
 * the credential entire, wherever it turns up, with nothing around it to keep. */
const STRUCTURAL_SHAPES = [
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
    /PuTTY-User-Key-File-\d/,
    /* scheme://user:password@host — the password is the point; a Sentry DSN (`https://key@host`) has no colon
     * before the `@` and is deliberately not this. A userinfo that is nothing but asterisks is a password
     * somebody already masked (maskCredentialMaterial below leaves this exact shape behind), and reading it as
     * a credential would have a masked file still answer "yes, there is one in here". */
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
    // A JWT: three base64url segments, the first two of which decode from `{"` and so always begin `ey`.
    /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\./,
];

const TOKEN_SHAPES = [...STRUCTURAL_SHAPES, ...ISSUED_TOKENS];

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

/* THE SAME DEFINITION APPLIED RATHER THAN ASKED: the text back with every credential in it blanked, and
 * everything else byte for byte.
 *
 * WHERE IT RUNS is what lets it be this blunt (sandbox agent/agent-redaction.ts): only over a tool result whose
 * INPUT named credential material — a Read of `.env`, a `cat ~/.npmrc`, a Grep through `~/.aws`. The name
 * heuristics that run over ARBITRARY output have to be timid, and the timidity is measured rather than
 * theoretical: matching on the key alone rewrote `oauthToken === undefined` mid-comparison and broke a JSON
 * body at `"cacheReadTokens":26170149`. This pass is pointed at a file the path table already calls a
 * credential store, where a `key = value` IS the credential and there is no prose to protect.
 *
 * IT COVERS THE HALF THE VAULT CANNOT. Value masking is exact and complete for what this sandbox STORES, and
 * blind to everything else: the project's own `.env`, a token a deploy minted an hour ago, whatever the owner
 * pasted into the repo this agent was pointed at. Those are the credentials a read actually leaks, and with
 * them blanked a read is worth about as much to a stranger as the file's key names — which is what lets the
 * command gate stop asking about READS and ask about SENDING (sandbox guard/actions.ts).
 *
 * THE MASK IS ANONYMOUS, never a `{{secret:name}}` reference. A reference is a promise that the exits resolve
 * it back to a value, and this pass is inferring from shape: minting one would put a token in the model's hands
 * that resolves to nothing, discovered when the deploy 401s. The cost is stated plainly: a file the model
 * rewrites wholesale from a masked read loses the value it was never shown. That is the same trade the terminal
 * filter has always made, and the alternative is handing the model the credential so it can copy it back.
 *
 * A PuTTY `.ppk` body is the known gap: unlike PEM it has no closing line to bound the mask, so its key
 * material survives this pass. The file still reads as credential material to everything else here, so the gate
 * still asks before a command carrying it reaches the internet. */
const MASK = "***";

// The `g` twins, built once: the tables above are written without `g` because `test` is what the detector
// wants, and `replace`/`replaceAll` demands one.
const globally = (patterns: readonly RegExp[]): readonly RegExp[] => patterns.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));
const ISSUED_TOKENS_G = globally(ISSUED_TOKENS);
const CREDENTIAL_ASSIGNMENT_G = new RegExp(CREDENTIAL_ASSIGNMENT.source, CREDENTIAL_ASSIGNMENT.flags);

/* The two structural shapes that mask to something other than themselves. A PEM's header and footer stay so the
 * model can still see WHICH key it is looking at and that a key is what it is looking at; a URL keeps its scheme,
 * user and host, because a `DATABASE_URL` with the host blanked is a connection string nobody can debug. */
const PRIVATE_KEY_BLOCK = /(-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----)[\s\S]*?(-----END \2PRIVATE KEY-----)/g;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)(?!\*+@)[^\s/@]{3,}@/gi;

/* A VALUE THAT OPENS A DEFERRED REFERENCE, skipped whole. The detector cuts these out before it looks
 * (DEFERRED_VALUE); masking cannot cut anything out, so it recognises the OPENER instead — and the opener is
 * what a truncated one leaves behind. `STRIPE_SECRET={{secret:STRIPE}}` is the case that matters: the bare-value
 * arm stops at the first `}`, so what reaches this test is `{{secret:STRIPE`, which no whole-value placeholder
 * pattern can match and which masking would turn into `***}}` — this workspace's own convention for a file that
 * holds no credential, silently vandalised. Anchored at the start so a generated password that merely CONTAINS
 * a `$` is still masked. */
const DEFERRED_OPENER = /^(?:\{\{|\$)/;

export const maskCredentialMaterial = (text: string): string =>
    ISSUED_TOKENS_G.reduce((masked, token) => masked.replace(token, MASK), text)
        .replace(PRIVATE_KEY_BLOCK, `$1\n${MASK}\n$3`)
        .replace(URL_PASSWORD, `$1${MASK}@`)
        /* The value of a credential-named assignment, in place, with its key, separator and quoting left
         * standing: `GITHUB_TOKEN="***"` is a line the model can still reason about and still rewrite, where a
         * blanked-out line is a config it cannot read at all. The skips are the detector's own — a value too
         * short to be issued, a template's placeholder, a `${VAR}` or `{{secret:NAME}}` deferred elsewhere —
         * so the two halves agree on what a credential is and nothing is masked that was never one. */
        .replace(CREDENTIAL_ASSIGNMENT_G, (match, ...groups: unknown[]) => {
            const value = (groups[0] ?? groups[1] ?? groups[2] ?? "") as string;
            const trimmed = value.trim();
            if (trimmed.length < MIN_VALUE || PLACEHOLDER.test(trimmed) || DEFERRED_OPENER.test(trimmed)) {
                return match;
            }
            // The value is the last thing the pattern matched, so its own text locates it inside the match
            // without the pattern having to hand back offsets.
            const at = match.lastIndexOf(value);
            return `${match.slice(0, at)}${MASK}${match.slice(at + value.length)}`;
        });
