import { copyTemplates, staticCopy } from "@intentic/ui/i18n";

// What of a piece of on-screen text a session replay (and a click event, eventPrivacy.ts) may keep. Default-deny: text is
// turned into asterisks unless one of the rules below recognises it, so a view added later is masked before anyone has
// heard of it. The rules, in the order they are tried:
//
//  - The interface's own wording: a message an i18n catalog spells out (`staticCopy`), the product's name, and text with
//    no letters or digits in it (a separator, a bullet, a full stop).
//  - A quantity standing alone: "3", "42%", "1.5 GB", "about 3 min left", "4 / 10". A bare number is at most three digits
//    or comma-grouped, so a PIN, a postcode, a year, a phone number or an IP address does not read as one.
//  - Our sentence around a value: a message with placeholders (`copyTemplates`, "{count} files changed") keeps its
//    wording, and each value is judged by these same rules, so "3 files changed" replays whole and "Delete
//    src/a.ts?" keeps "Delete" and stars the path. A piece of such a message rendered on its own (an `<i18n-t>` slot's
//    neighbours) is our wording too, and so is each part of text joined by " · ".
//  - Inside `pre` or `code` nothing is kept: those hold commands with setup codes in them, and code.
//  - Inside `[data-replay="diagnostic"]`, the words are kept: what a machine reported about a failed setup, which is
//    the one thing a replay of a stuck setup has to show. Addresses, paths, emails, hostnames and identifiers in it are
//    still starred (`scrubDiagnostic`).
//
// The catalogs make a sound allowlist because `_tools/checks/i18n-literals.mjs` ratchets English typed into templates,
// so chrome reaches the screen through them and no component needs a marker. A literal still typed into a template is
// masked, which is the safe direction.
//
// The privacy policy says what a replay holds (_site/site-content/src/legal.ts). Change one, change the other.

// The product's name, drawn by the shell's mark from a constant rather than a catalog.
const BRAND = new Set([`intentic`, `Intentic`]);

// No letter and no digit: punctuation, symbols, space.
const UNWORDED = /^[^\p{L}\p{N}]*$/u;

const UNIT = `(?:%|[kKMGT]i?B|B|ms|s|secs?|m|mins?|h|hrs?|d|w|wk|mo|y|yr|x|×|seconds?|minutes?|hours?|days?|weeks?|months?|years?)`;
// Up to three digits, or a comma-grouped thousand; with a unit, four digits too ("1024 MB").
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?`;
const MEASURE = String.raw`(?:\d{1,4}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?\s?${UNIT}`;
const ONE = `(?:${MEASURE}|${AMOUNT})`;
const QUANTITY = new RegExp(String.raw`^[([]?(?:about |~ ?|≈ ?|[<>+−-])?${ONE}(?:\s?/\s?${ONE}|\s${MEASURE})?(?: ago| left)?[)\]]?[.,:;]?$`);

// A message's placeholder, as vue-i18n writes one.
const PLACEHOLDER = /\{\s*[\w.]+\s*\}/g;
// Text joined from parts by a spaced separator.
const SEPARATOR = /(\s[·•|—–]\s)/;
// Past this a text node is content rather than a sentence of ours, and not worth a template's regex.
const LONGEST_SENTENCE = 600;
// How deep a value inside a value is judged before it is starred.
const DEEPEST = 2;
// A template with less wording than this ("{a} and {b}") would match anyone's sentence and keep its small words, so it
// only lends its pieces to `<i18n-t>` slots.
const FEWEST_LETTERS = 4;

const collapse = (text: string): string => text.replace(/\s+/g, ` `).trim();
const stars = (text: string): string => text.replace(/\S/g, `*`);
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const hasLetter = (text: string): boolean => /\p{L}/u.test(text);

/** Whether this text is the interface's own wording (or nothing at all), as opposed to anything anyone wrote. */
export const isAppCopy = (text: string): boolean => {
    const words = collapse(text);
    return words === `` || staticCopy().has(words);
};

interface Template {
    // The wording between the placeholders, one more than there are placeholders.
    readonly literals: readonly string[];
    // Each placeholder's name, in order.
    readonly names: readonly string[];
    readonly pattern: RegExp;
}

// A placeholder's name says what kind of value fills it. A count is kept only as a number, so "Settings files" does not
// replay through "{count} files"; a name, a path or an address is starred whatever it reads as; a version only as one.
const COUNTED = new Set([`count`, `n`, `total`, `max`, `min`, `percent`, `tokens`, `hours`, `minutes`, `seconds`, `days`, `cores`, `done`, `files`, `refreshes`, `hidden`, `left`, `line`, `lines`, `attempt`, `attempts`]);
const NAMED = new Set([`name`, `names`, `title`, `path`, `email`, `host`, `repo`, `repos`, `sandbox`, `account`, `query`, `id`, `machine`, `who`, `message`, `note`, `command`, `destination`, `domain`, `url`, `address`, `file`, `folder`, `dir`, `branch`, `user`, `owner`, `project`]);
const VERSIONED = new Set([`version`, `latest`]);
// A step a machine reports it is on ("Starting your sandbox: {step}"), judged like the rest of what a machine reports.
const REPORTED = new Set([`step`, `stage`]);
const VERSION = /^v?\d{1,4}(?:\.\d{1,4}){1,3}(?:[-+][\w.]+)?$/;

// The templates by one word of their own wording, so a text node is tried only against messages that share a word with
// it; and every piece of wording between placeholders, for the pieces an `<i18n-t>` renders as nodes of their own.
interface TemplateIndex {
    readonly size: number;
    readonly byWord: Map<string, string[]>;
    readonly fragments: Set<string>;
}

let templateIndex: TemplateIndex = { size: -1, byWord: new Map(), fragments: new Set() };
const compiled = new Map<string, Template>();

// The template's longest word that holds no placeholder, which is the one least likely to be shared by unrelated text.
const keyWord = (template: string): string | undefined =>
    template
        .split(` `)
        .filter((word) => !word.includes(`{`) && hasLetter(word))
        .reduce<string | undefined>((longest, word) => (longest === undefined || word.length > longest.length ? word : longest), undefined);

const indexOfTemplates = (): TemplateIndex => {
    const all = copyTemplates();
    if (all.size === templateIndex.size) {
        return templateIndex;
    }
    const byWord = new Map<string, string[]>();
    const fragments = new Set<string>();
    for (const template of all) {
        for (const piece of template.split(PLACEHOLDER)) {
            const words = collapse(piece);
            if (hasLetter(words)) {
                fragments.add(words);
            }
        }
        const key = keyWord(template);
        if (key !== undefined && template.replace(PLACEHOLDER, ``).replace(/[^\p{L}]/gu, ``).length >= FEWEST_LETTERS) {
            byWord.set(key, [...(byWord.get(key) ?? []), template]);
        }
    }
    templateIndex = { size: all.size, byWord, fragments };
    return templateIndex;
};

const compile = (template: string): Template => {
    const known = compiled.get(template);
    if (known !== undefined) {
        return known;
    }
    const literals = template.split(PLACEHOLDER);
    const names = [...template.matchAll(PLACEHOLDER)].map(([placeholder]) => placeholder.slice(1, -1).trim());
    const made = { literals, names, pattern: new RegExp(`^${literals.map(escape).join(`(.+?)`)}$`, `u`) };
    compiled.set(template, made);
    return made;
};

// How much of a template is its own wording rather than room for a value.
const wording = (template: Template): number => template.literals.join(``).length;

// Our wording with each value judged on its own, or undefined when no template of ours reads this way. Of the templates
// that read this way the one with the most wording wins: "Installing {name}" would read all of "Installing my-laptop on
// this device" as a name, where "Installing {what} on this device" keeps the sentence and judges only the value.
const fillTemplate = (words: string, depth: number): string | undefined => {
    const { byWord } = indexOfTemplates();
    const tried = new Set<string>();
    let best: { template: Template; values: RegExpExecArray } | undefined;
    for (const word of new Set(words.split(` `))) {
        for (const template of byWord.get(word) ?? []) {
            if (tried.has(template)) {
                continue;
            }
            tried.add(template);
            const made = compile(template);
            const values = made.pattern.exec(words);
            if (values !== null && (best === undefined || wording(made) > wording(best.template))) {
                best = { template: made, values };
            }
        }
    }
    if (best === undefined) {
        return undefined;
    }
    const { template, values } = best;
    return template.literals.map((literal, at) => (at === 0 ? literal : `${maskValue(template.names[at - 1] ?? ``, values[at] ?? ``, depth)}${literal}`)).join(``);
};

// One filled-in value, judged by what its placeholder is for and then by the rules for any text.
const maskValue = (name: string, value: string, depth: number): string => {
    if (COUNTED.has(name)) {
        return QUANTITY.test(value) || /^\d{1,6}$/.test(value) ? value : stars(value);
    }
    if (NAMED.has(name)) {
        return stars(value);
    }
    if (VERSIONED.has(name)) {
        return VERSION.test(value) ? value : stars(value);
    }
    if (REPORTED.has(name)) {
        return scrubDiagnostic(value);
    }
    return maskCopy(value, depth + 1);
};

// The whitespace the node arrived with, around what is kept of it.
const reattach = (text: string, kept: string): string => `${/^\s*/.exec(text)?.[0] ?? ``}${kept}${/\s*$/.exec(text)?.[0] ?? ``}`;

const maskCopy = (text: string, depth: number): string => {
    const words = collapse(text);
    if (words === `` || staticCopy().has(words) || BRAND.has(words) || UNWORDED.test(words) || QUANTITY.test(words)) {
        return text;
    }
    const { fragments } = indexOfTemplates();
    if (fragments.has(words)) {
        return text;
    }
    if (depth >= DEEPEST || words.length > LONGEST_SENTENCE) {
        return stars(text);
    }
    // Parts first: a template ending in a name would otherwise swallow everything before it as the name.
    if (SEPARATOR.test(words)) {
        return reattach(
            text,
            words
                .split(SEPARATOR)
                .map((part) => (SEPARATOR.test(part) ? part : maskCopy(part, depth + 1)))
                .join(``),
        );
    }
    const filled = fillTemplate(words, depth);
    return filled === undefined ? stars(text) : reattach(text, filled);
};

// Hosts a diagnostic may name: ours, and the registries and docs a setup talks to. Exact names only: a subdomain of
// intentic.dev is somebody's sandbox.
const PUBLIC_HOSTS = new Set([`intentic.dev`, `app.intentic.dev`, `ghcr.io`, `github.com`, `docker.com`, `docs.docker.com`, `get.docker.com`, `download.docker.com`, `hub.docker.com`, `docker.io`]);
// Addresses a diagnostic may quote: our image, our org's packages, our site and Docker's.
const PUBLIC_PREFIXES = [`ghcr.io/intentic/`, `https://github.com/orgs/intentic/`, `https://intentic.dev/`, `https://docs.docker.com/`, `https://get.docker.com`];

// A word that could name a person, a machine or a place: an email, a path or address, a hostname, an IP, or an
// identifier (a sandbox or container name, a token, a digest).
const isPersonal = (core: string): boolean => {
    if (core.includes(`@`)) {
        return true;
    }
    if (core.includes(`/`) || core.includes(`\\`)) {
        return !PUBLIC_PREFIXES.some((prefix) => core.startsWith(prefix));
    }
    if (/^[\w-]+(?:\.[\w-]+)*\.[a-z][\w-]*$/i.test(core)) {
        return !PUBLIC_HOSTS.has(core.toLowerCase());
    }
    return (
        /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(core) ||
        /^[\da-f]*:[\da-f:]*:[\da-f:]*$/i.test(core) ||
        core.length >= 24 ||
        core.includes(`_`) ||
        (core.match(/-/g)?.length ?? 0) >= 2 ||
        (core.length >= 8 && /\d/.test(core) && /\p{L}/u.test(core))
    );
};

/**
 * What a machine's own report keeps in a replay or an event: its words, with every email, path, address, hostname and
 * identifier in it starred. For text the interface shows verbatim from a setup run (`data-replay="diagnostic"`).
 */
export const scrubDiagnostic = (text: string): string =>
    text.replace(/\S+/g, (token) => {
        // Quotes, brackets and the punctuation a sentence ends a word with are not part of what the word names.
        const [, before = ``, core = ``, after = ``] = /^([("'`[]*)(.*?)([)"'`\].,:;!?]*)$/su.exec(token) ?? [];
        return core !== `` && isPersonal(core) ? `${before}${stars(core)}${after}` : token;
    });

// Where the rules change, nearest first: commands and code are masked whole, a machine's report keeps its words.
const ZONES = `pre, code, [data-replay="diagnostic"]`;

/**
 * Masks one text node for a replay, see the head of this file. `element` is the node's parent, which the recorder hands
 * over; without one (a click event's text) only the wording rules apply.
 */
export const maskText = (text: string, element?: Element | null): string => {
    if (isAppCopy(text)) {
        return text;
    }
    const zone = element?.closest(ZONES);
    if (zone !== null && zone !== undefined) {
        return zone.matches(`[data-replay="diagnostic"]`) ? scrubDiagnostic(text) : stars(text);
    }
    return maskCopy(text, 0);
};
