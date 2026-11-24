// Stored values shorter than SECRET_VALUE_MIN are not masked wherever they appear: a 6-character password blanked
// everywhere would also blank every unrelated "hunter" or "1234" in ordinary output. They are masked instead where the
// text around them says a secret stands there, so the value is the one being named rather than a coincidence:
//   - after a key that names a secret or the secret itself: `password=v`, `DB_PASS: v`, `"api_key": "v"`, `NAME=v`,
//     `token => 'v'`, JSON inside a string (`{\"password\":\"v\"}`), the field of a vault name
//     (`netdisk/password` -> `password: v`);
//   - as a flag's argument: `--password v`, `--db-pass=v`, and `-p` for the tools known to take a password there
//     (`mysql -pv`, `sshpass -p v`);
//   - as a URL's userinfo password: `https://user:v@host`.
// The value must stand whole there (a quote, a space, a separator or the end follows it), and match exactly, case
// included. Pure, with no imports, so the terminal filter and the daemon's tool-result masking run the same rule.
//
// Below those, `redactText`: everything the filter emits masked by credential-shaped names, issuer tokens, private key
// blocks and the stored values. Moved here from cleaners.mjs, which re-exports it, on 2026-11-24.

// A key naming a secret: any identifier containing one of these words, in any case.
const SECRET_KEY_WORDS = String.raw`[\w.-]*(?:pass|pwd|secret|token|api[_-]?key|credential|private[_-]?key)[\w.-]*`;
// Tools whose `-p` takes the password, attached (`mysql -pv`) or as the next word (`sshpass -p v`).
const PASSWORD_FLAG_TOOLS = String.raw`(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump|sshpass)`;
// What may follow a value for it to stand whole: the end, whitespace, a closing quote or bracket, a separator, or the
// backslash of an escaped quote in JSON-in-a-string.
const VALUE_END = String.raw`(?=$|[\s"'\`,;&|)}\]>\\])`;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

// The keys that name this one secret: its own name, and for a vault entry (`id/field`) the field.
const ownKeys = (name) => {
    const field = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : "";
    return [name, field].filter((key) => key !== "").map(escapeRegExp);
};

const contextPattern = (name, value) => {
    const key = [SECRET_KEY_WORDS, ...ownKeys(name)].join("|");
    const v = escapeRegExp(value);
    const contexts = [
        // key = value, key: value, "key": "value", key => value, key := value; the key not glued to a longer word.
        String.raw`(?<=(?<![\w.-])(?:\\?["'])?(?:${key})(?:\\?["'])?[ \t]*(?:=>|:=|[:=])[ \t]*(?:\\?["'\`])?)`,
        // --key value, --key=value, -key value.
        String.raw`(?<=(?:^|\s)--?(?:${key})(?:=|[ \t]+)["']?)`,
        // mysql -pvalue, sshpass -p value.
        String.raw`(?<=\b${PASSWORD_FLAG_TOOLS}\b[^\n]*?[ \t]-p[ \t]?["']?)`,
    ];
    // Case-insensitive for the keys; the replacer checks the value itself matched exactly.
    return new RegExp(String.raw`(?:${contexts.join("|")})(${v})${VALUE_END}|(?<=://[^\s/:@]*:)(${v})(?=@)`, "gim");
};

// The short values worth a contextual pass: non-empty, one line, under the floor that masks by value.
export const shortSecretTargets = (named, floor) =>
    named
        .map(({ name, value }) => ({ name, value: value.trim() }))
        .filter(({ value }) => value !== "" && value.length < floor && !value.includes("\n"));

// Replaces each short value with `replacement(name)` where it stands in a secret-like context, leaving every other
// occurrence alone. Returns the same string when nothing matched.
// Compiled once per name and value: a global RegExp is safe to share, since replace starts it at 0 and leaves it there.
// 2026-11-24: replaced compiling the lookbehind pattern afresh for every string, once per line a value appeared in.
const patterns = new Map();
const cachedPattern = (name, value) => {
    const key = JSON.stringify([name, value]);
    let pattern = patterns.get(key);
    if (pattern === undefined) {
        pattern = contextPattern(name, value);
        // Bounded: the stores change rarely, but a long-lived daemon must not keep every value it ever saw.
        if (patterns.size >= 1000) {
            patterns.clear();
        }
        patterns.set(key, pattern);
    }
    return pattern;
};

export const maskShortSecrets = (text, targets, replacement) => {
    let out = text;
    for (const { name, value } of targets) {
        if (!out.includes(value)) {
            continue;
        }
        out = out.replace(cachedPattern(name, value), (match, keyed, inUrl) => ((keyed ?? inUrl) === value ? replacement(name) : match));
    }
    return out;
};

// The short values as mask entries beside the exact ones, marked `contextual` so nothing splits on them.
export const contextualEntries = (named, floor, reference) =>
    shortSecretTargets(named, floor).map(({ name, value }) => ({ target: value, replacement: reference(name), name, contextual: true }));

// Masks a text against a list of mask entries: each exact target wherever it stands, longest first as the list comes,
// then the `contextual` ones only where their context names a secret.
export const maskValues = (text, entries, reference) => {
    let out = text;
    const contextual = [];
    for (const { target, replacement, name, contextual: short } of entries) {
        if (short === true) {
            contextual.push({ name, value: target });
        } else if (out.includes(target)) {
            out = out.split(target).join(replacement);
        }
    }
    return contextual.length === 0 ? out : maskShortSecrets(out, contextual, reference);
};

// Masks common secret shapes before output reaches the model, as defense-in-depth. A secret-shaped NAME is not enough
// (source often says "token" without holding one), so the VALUE must look like a credential too.
const SECRET_NAME = String.raw`[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*`;
// A single `=` or `:`, never `===`/`!==`/`=>`; optional closing quote covers a quoted JSON key.
const ASSIGN = String.raw`["']?\s*[:=](?![=>])\s*`;
// `\x60` is a backtick: template-literal values are quoted too.
const QUOTED_VALUE = String.raw`(["'\x60])([^"'\x60\n]{6,})\2`;
// No `.` (property access) and not a call: `usage.inputTokens` and `computed(` are expressions, not values.
const BARE_VALUE = String.raw`[\w+/=~-]{6,}(?![\w+/=~(-])`;

// Credentials that name their own issuer: the literal prefix it mints them with and the body that follows. The contract
// holds the same table (_shared/sandbox-contract/src/policy/credential-material.ts); this is a copy only because this
// package imports nothing but node builtins, and the daemon's src/secrets/terminal-masking-parity.test.ts fails the moment
// the two part. The sides read it with different appetites, on purpose:
//   - here, beside a credential-shaped NAME, the prefix alone marks the value at any length (`TOKEN=ghp_x`): the name
//     already said it is a credential, so recall wins;
//   - anywhere else in output, and in the contract everywhere, only the whole shape counts, since a bare `sk-` in prose
//     or a CSS class is not one.
export const CREDENTIAL_ISSUERS = [
    { prefix: "npm_", body: "[A-Za-z0-9]{30,}" },
    { prefix: "ghp_", body: "[A-Za-z0-9]{20,}" },
    { prefix: "gho_", body: "[A-Za-z0-9]{20,}" },
    { prefix: "ghu_", body: "[A-Za-z0-9]{20,}" },
    { prefix: "ghs_", body: "[A-Za-z0-9]{20,}" },
    { prefix: "ghr_", body: "[A-Za-z0-9]{20,}" },
    { prefix: "github_pat_", body: "[A-Za-z0-9_]{50,}" },
    { prefix: "glpat-", body: "[A-Za-z0-9_-]{16,}" },
    { prefix: "xoxa-", body: "[A-Za-z0-9-]{10,}" },
    { prefix: "xoxb-", body: "[A-Za-z0-9-]{10,}" },
    { prefix: "xoxo-", body: "[A-Za-z0-9-]{10,}" },
    { prefix: "xoxp-", body: "[A-Za-z0-9-]{10,}" },
    { prefix: "xoxr-", body: "[A-Za-z0-9-]{10,}" },
    { prefix: "xoxs-", body: "[A-Za-z0-9-]{10,}" },
    { prefix: "sk-", body: "[A-Za-z0-9_-]{20,}" },
    { prefix: "pk-", body: "[A-Za-z0-9_-]{20,}" },
    { prefix: "rk-", body: "[A-Za-z0-9_-]{20,}" },
    { prefix: "sk_live_", body: "[A-Za-z0-9]{16,}" },
    { prefix: "rk_live_", body: "[A-Za-z0-9]{16,}" },
    { prefix: "AKIA", body: String.raw`[0-9A-Z]{16}\b` },
    { prefix: "ASIA", body: String.raw`[0-9A-Z]{16}\b` },
    { prefix: "AIza", body: String.raw`[0-9A-Za-z_-]{35}\b` },
    { prefix: "ya29.", body: "[0-9A-Za-z_-]{20,}" },
    { prefix: "hf_", body: "[A-Za-z0-9]{30,}" },
    { prefix: "dop_v1_", body: "[a-f0-9]{60,}" },
    { prefix: "shpat_", body: "[a-fA-F0-9]{32,}" },
    // SendGrid: a key id and its secret, dot-separated.
    { prefix: "SG.", body: String.raw`[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}` },
    // A JWT: three base64url segments, the first two of which decode from `{"` and so always begin `eyJ` and `ey`.
    { prefix: "eyJ", body: String.raw`[A-Za-z0-9_-]{9,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*` },
];
export const CREDENTIAL_ISSUER_PREFIXES = CREDENTIAL_ISSUERS.map(({ prefix }) => prefix);

// RegExp.escape is Node 24; spelled out so the file does not depend on the node it runs on. Its own copy, not the one
// above: that one also escapes `/` and `-`, and the issuer patterns stay exactly as they were built.
const escapeIssuer = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const ISSUER_PREFIX = new RegExp(`^(?:${CREDENTIAL_ISSUER_PREFIXES.map(escapeIssuer).join("|")})`);
// Starts where no word or kebab-case word runs into it: `task-sk-runner-config-file` is a name, not a key. The other
// side builds its patterns the same way.
const ISSUED_TOKENS = CREDENTIAL_ISSUERS.map(({ prefix, body }) => new RegExp(String.raw`(?<![\w-])${escapeIssuer(prefix)}${body}`, "g"));

// What counts as a credential once the NAME already matched: machine-generated values carry letters and digits
// together, but so do plain counts and paths.
//   1. A known issuer prefix (CREDENTIAL_ISSUER_PREFIXES) is a credential at any length.
//   2. Otherwise it must be entropic and not: all-digits, a path/URL/`${template}`, or SCREAMING_SNAKE (a name, not a
//      value).
//   3. And longer than a human would type, or it might be a fixture value like `"tok-abc-123"`.
// The gap is deliberate: a handwritten passphrase reads exactly like an identifier.
const NUMERIC_VALUE = /^[\d_,.]+$/;
const STRUCTURAL_VALUE = /[\s/\\${}]/;
const ENV_NAME_VALUE = /^[A-Z0-9_]+$/;
const ENTROPIC_VALUE = /^(?=[^\n]*\d)(?=[^\n]*[A-Za-z])/;
const HANDWRITTEN_MAX = 12;
const looksLikeCredential = (value) =>
    ISSUER_PREFIX.test(value) ||
    (value.length > HANDWRITTEN_MAX &&
        ENTROPIC_VALUE.test(value) &&
        !NUMERIC_VALUE.test(value) &&
        !STRUCTURAL_VALUE.test(value) &&
        !ENV_NAME_VALUE.test(value));

// A `{{secret:name}}` reference, capturing the name: the alphabet every store below names a value with (env keys,
// `<id>/<field>`). The contract's SECRET_REFERENCE is the same pattern, pinned to this one by the daemon's parity test.
// Not global, so it carries no `lastIndex` between callers.
export const SECRET_REFERENCE = /\{\{secret:([A-Za-z0-9_./-]+)(?:\|(file))?\}\}/;
// Double braces, not a value-lookalike, since substitution must be exact-match; a key-shaped token invites a model to
// "fix" it or reason about its length. The daemon's tool-result masking re-exports this one.
export const secretReference = (name) => `{{secret:${name}}}`;

// Each pattern carries a gate its text must pass for it to match at all, asked of the text the patterns before it left:
// a line pays only for the patterns that could fire on it, and the sequence masks exactly what it would ungated.
const SECRET_NAME_WORD = /TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY/i;
const BEARER_WORD = /Bearer\s/i;
const SECRET_PATTERNS = [
    [
        new RegExp(`\\b(${SECRET_NAME}${ASSIGN})(?:${QUOTED_VALUE}|(${BARE_VALUE}))`, "gi"),
        // Quoted and bare arrive in different groups because only the quoted one has a quote to put back.
        (match, assignment, quote, quoted, bare) => (looksLikeCredential(quoted ?? bare) ? `${assignment}${quote ?? ""}***${quote ?? ""}` : match),
        (text) => SECRET_NAME_WORD.test(text),
    ],
    ...ISSUED_TOKENS.map((token, index) => [token, "***", (text) => text.includes(CREDENTIAL_ISSUER_PREFIXES[index])]),
    // Same rule for a bearer value: prose about tokens carries no digit, every real bearer token does.
    [/\b(Bearer\s+)(?=[\w.-]*\d)[\w.-]{8,}/gi, "$1***", (text) => BEARER_WORD.test(text)],
    // scheme://user:password@host for any scheme (a postgres DSN as much as an https remote). Any length, unlike the
    // contract's three-character floor: output reaching a model is not a file someone meant to publish. A `/` ends the
    // password, so `http://host:3000/@scope/pkg` is a port and a path, and a reference already standing in is kept.
    [/\b([a-z][a-z0-9+.-]*:\/\/[^:@\s/]+:)(?!\{\{secret:)[^@\s/]+@/gi, "$1***@", (text) => text.includes("://")],
];
// Every gate in two scans, cased as their patterns read (one case-insensitive scan of all took twice as long).
const NAMED_GATE = new RegExp([SECRET_NAME_WORD.source, BEARER_WORD.source, ":\\/\\/"].join("|"), "i");
const ISSUER_GATE = new RegExp(CREDENTIAL_ISSUER_PREFIXES.map(escapeIssuer).join("|"));

// A private key spans lines, which the per-line patterns above cannot see, so these run over the joined body first; the
// same shapes as the contract's maskCredentialMaterial, so the terminal and the tools mask a key alike (the daemon's
// parity test compares the two on the same keys). A PEM keeps its header and footer with its body masked through to
// the matching footer, or through its last body line when the output was cut short; a PuTTY key keeps its first line's
// label. Already-masked text is skipped, so masking twice changes nothing.
const MASKED_NEXT = String.raw`(?!(?:\s|\\[nr])*\*\*\*)`;
// One armored body line after a newline or a `\n` escape: a whole line of base64, or a `Proc-Type: 4,ENCRYPTED` header.
const ARMOR_LINES = String.raw`(?:(?:\s|\\[nr])+(?:[A-Za-z-]+:[^\n\\]*|[A-Za-z0-9+/=]+(?=[ \t]*(?:[\r\n"'\x60<>,;})\]]|\\[nr]|$))))*`;
const PRIVATE_KEY_BLOCK = new RegExp(
    String.raw`(-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----)${MASKED_NEXT}(?:[\s\S]*?(-----END \2PRIVATE KEY\3-----)|${ARMOR_LINES})`,
    "g",
);
const PUTTY_KEY = new RegExp(String.raw`(PuTTY-User-Key-File-\d:)${MASKED_NEXT}[^\n\\]*${ARMOR_LINES}`, "g");
const maskKeyBlocks = (text) =>
    // The cheap test first: almost no output holds a key, and the block patterns scan the whole body.
    text.includes("PRIVATE KEY") || text.includes("PuTTY-User-Key-File-")
        ? text
              .replace(PRIVATE_KEY_BLOCK, (_block, header, _label, _kind, footer) =>
                  footer === undefined ? `${header}\n***` : `${header}\n***\n${footer}`,
              )
              .replace(PUTTY_KEY, "$1 ***")
        : text;

// Every line masked: key blocks across the joined body first (a token shape matched inside a key's body would cut the
// body short), then known values and the per-line patterns.
export const redactLines = (lines, values = []) => {
    const joined = lines.join("\n");
    const keyed = maskKeyBlocks(joined);
    // maskValues replaces only what it finds, so a line holding none of the values present in the body skips it.
    const present = values.filter(({ target }) => keyed.includes(target));
    return (keyed === joined ? lines : keyed.split("\n")).map((line) => redactLine(line, values, present));
};

// Masks a whole body for the two paths that skip the pipeline: the holdout and the fail-open catch. Neither excuses
// handing over a credential; idempotent, so re-running it after the pipeline already masked a line costs a scan and
// changes nothing.
export const redactText = (text, values = []) => redactLines(text.split("\n"), values).join("\n");

// 2026-11-24: the value and pattern gates replaced running maskValues and all 31 patterns on every line, which a line
// pays three or four times per command (the template and JSON checks, the redact stage, filterRun's last pass): one
// redactText over a 50k-line build log 176 ms → 41 ms.
const redactLine = (line, values, present) => {
    const masked = present.some(({ target }) => line.includes(target)) ? maskValues(line, values, secretReference) : line;
    return !NAMED_GATE.test(masked) && !ISSUER_GATE.test(masked)
        ? masked
        : SECRET_PATTERNS.reduce((acc, [pattern, replacement, gate]) => (gate(acc) ? acc.replace(pattern, replacement) : acc), masked);
};
