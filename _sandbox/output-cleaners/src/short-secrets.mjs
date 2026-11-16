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
export const maskShortSecrets = (text, targets, replacement) => {
    let out = text;
    for (const { name, value } of targets) {
        if (!out.includes(value)) {
            continue;
        }
        out = out.replace(contextPattern(name, value), (match, keyed, inUrl) => ((keyed ?? inUrl) === value ? replacement(name) : match));
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
