import type { CapabilityCatalogEntry } from "@intentic-app/capability-catalog";
import { type CapabilityField, fieldApplies } from "@intentic/extension-manifest";
import { type ForticlientConnection, isForticlientCiphertext, VAULTED } from "@intentic/sandbox-contract";

/* THE CARD'S FORM, adding a connection and editing one are the same form, and this is why they can be.
 *
 * A card declares fields; everything between that declaration and the daemon's input is decided here, which
 * fields are on screen right now, what a half-filled one says, what a fresh form is pre-filled with, and which
 * answers survive into the config. The form's own state (the values, what has been touched) stays on the page
 * because it is reactive; the rules over it are plain functions of that state, which is what lets each one be
 * read on its own and pinned in a test.
 *
 * THE ONE THING AN EDIT CHANGES is what an empty box means, and it changes it for exactly one kind of box. A
 * connection's credentials are never sent to a browser, so a form opened over a live connection starts with its
 * password fields blank, and blank, on an add, means "you haven't filled this in yet". Reading it that way on
 * an edit is what made every change to a connection cost a re-typed key: the field is required, so the submit
 * is blocked until you find the credential again, and a dropped one silently erases what is stored.
 *
 * So every rule below that asks about a value takes `stored`, the credential keys this connection is actually
 * holding, which the daemon names without ever sending (CapabilitySummary.secrets). Where it holds one, blank
 * means KEEP: nothing to re-type, nothing required, and the config carries the marker the daemon resolves back
 * into the credential (VAULTED). An add passes an empty set and every rule reads exactly as it did. */

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const URL_RE = /^https?:\/\/.+/i;

/** The form's values, keyed by field. A switch carries "on"/"off", the form speaks strings throughout. */
export type FormValues = Record<string, string>;

/* The credential keys the connection being edited already holds, empty when adding, which is what makes every
 * rule below read as it always did on an add. A named type rather than a bare Set so the argument says which
 * question it answers at each call site: "is this one already stored?", never "is this one secret?". */
export type StoredSecrets = ReadonlySet<string>;
// What every rule below defaults to: nothing stored, which is an add, and which is why an add reads exactly
// as it did before any of this existed.
const NOTHING_STORED: StoredSecrets = new Set<string>();

/** A blank box that means "keep what's there": this field holds a credential the browser was never shown. */
export const keepsSecret = (field: CapabilityField, value: string | undefined, stored: StoredSecrets): boolean =>
    field.secret === true && (value ?? ``).trim().length === 0 && stored.has(field.key);

// undefined means valid, here and in every rule below.
export const nameError = (name: string): string | undefined => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        return `Name is required.`;
    }
    if (!NAME_RE.test(trimmed)) {
        return `Use letters, digits, hyphens and underscores; must start with a letter or digit.`;
    }
    return undefined;
};

/* WHAT A FIELD REFUSES, one rule per line. Each answers about the value as typed and says so in the words the
 * person who typed it needs; the first that objects is what the field shows. Order is deliberate, an empty
 * required field has nothing else worth saying about it, so emptiness leads. */
type FieldRule = (field: CapabilityField, value: string) => string | undefined;

const RULES: readonly FieldRule[] = [
    (field, value) => (field.optional !== true && value.length === 0 ? `This field is required.` : undefined),
    (field, value) =>
        value.length > 0 && !field.secret && field.key.toLowerCase().includes(`url`) && !URL_RE.test(value)
            ? `Enter a valid URL (e.g. https://…).`
            : undefined,
    // A value lifted straight out of a FortiClient config is ciphertext, not a credential, the daemon rejects
    // it, so say so here rather than after a round-trip.
    (_field, value) =>
        value.length > 0 && isForticlientCiphertext(value)
            ? `FortiClient encrypted this with a key tied to the machine that exported it — it can't be used. Enter the real value.`
            : undefined,
    (field, value) => {
        if (value.length === 0 || field.key !== `port`) {
            return undefined;
        }
        const port = Number(value);
        return Number.isInteger(port) && port >= 1 && port <= 65_535 ? undefined : `Enter a valid port number (1–65535).`;
    },
];

export const fieldError = (field: CapabilityField, value: string | undefined, stored: StoredSecrets = NOTHING_STORED): string | undefined => {
    // Left alone on an edit, there is nothing to refuse about a value the user is keeping.
    if (keepsSecret(field, value, stored)) {
        return undefined;
    }
    const trimmed = (value ?? ``).trim();
    for (const rule of RULES) {
        const message = rule(field, trimmed);
        if (message !== undefined) {
            return message;
        }
    }
    return undefined;
};

// The fields shown as inputs (const-valued ones are baked into config, not rendered; when-gated ones only while
// their condition holds, `fieldApplies` is the same decision the daemon makes at install, imported rather
// than restated so the form cannot show a field the daemon will not accept, or hide one it demands).
export const shownFields = (entry: CapabilityCatalogEntry, values: FormValues): readonly CapabilityField[] =>
    entry.fields.filter((field) => field.value === undefined && fieldApplies(field, values));

/* WHICH FIELDS ANSWER THEMSELVES BESIDE THEIR LABEL rather than under it. A switch always does. A picker does
 * when its answers are short enough to sit in the same line as the question, and the test is the WIDTH of the
 * answers, not how many there are, because that is what actually decides whether the row fits.
 *
 * Counting options would have been the obvious rule and it is the wrong one: `Allowed`/`Blocked` and
 * `OpenAI-compatible`/`Anthropic-compatible` are both two options, and only one of them leaves room for a label
 * to its left. Measuring instead puts the six Allowed/Blocked permissions of a computer inline (where they halve
 * the form) and leaves the model-endpoint protocol and the VPN's three-protocol picker stacked (where they would
 * otherwise crush the label or wrap). A long list, the DH groups, fails the same test by itself. */
const INLINE_OPTIONS_BUDGET = 24;

export const inlineField = (field: CapabilityField): boolean => {
    if (field.boolean === true) {
        return true;
    }
    if (field.options === undefined || field.multiline === true) {
        return false;
    }
    return field.options.reduce((total, option) => total + option.label.length, 0) <= INLINE_OPTIONS_BUDGET;
};

// Every visible field answered (a switch always holds one of its two positions) and a name the daemon will take.
// A credential already stored counts as answered, see the header: on an edit, blank means keep.
export const formComplete = (entry: CapabilityCatalogEntry, values: FormValues, name: string, stored: StoredSecrets = NOTHING_STORED): boolean =>
    NAME_RE.test(name.trim()) &&
    shownFields(entry, values).every(
        (field) => field.optional === true || keepsSecret(field, values[field.key], stored) || (values[field.key] ?? ``).trim().length > 0,
    );

// A commit sha, which is the only `ref` an extension install may pin, a branch name would let the code move
// under an approval that was given for what was read.
const SHA_RE = /^[0-9a-f]{40}$/u;

export const isCommitSha = (value: string | undefined): boolean => SHA_RE.test(value ?? ``);

/* WHAT A FORM HOLDS WHEN IT OPENS, in the order each source earns its place. Later sources win, and the
 * sequence is the argument: the card's own defaults are the floor; the LIVE config of the connection being
 * edited is what the user actually has (resetting a switch to off every time a card is opened would turn "come
 * and look" into "turn it back off"); the workspace scan's prefill answers what a user would otherwise go and
 * look up. Dev autofill lands on top of all three, and lives in ./devSecrets so this stays a module of rules
 * rather than one that reads the browser.
 *
 * `live` is the connection being edited, the sole instance of a one-per-sandbox card, or whichever row the
 * reader opened. It never carries a credential (the daemon strips them), which is what `stored` above is for.
 *
 * A switch seeds to "off" rather than empty: it always shows one of its two positions, so an unseeded one would
 * both render as off and count as an unfilled required field, blocking a submit over a control the user can see
 * is answered. Fields gated by `when` are seeded regardless, so toggling a mode reveals an initialized field. */
export const seedValues = (
    entry: CapabilityCatalogEntry,
    live: Record<string, string | number | boolean | undefined> | undefined,
    prefill: Record<string, string>,
): FormValues => {
    const values: FormValues = {};
    for (const field of entry.fields) {
        if (field.value === undefined) {
            values[field.key] = field.default ?? (field.boolean === true ? `off` : ``);
        }
    }
    // Booleans arrive from the daemon's echo as booleans and from the form as "on"/"off".
    for (const [key, value] of Object.entries(live ?? {})) {
        values[key] = typeof value === `boolean` ? (value ? `on` : `off`) : String(value);
    }
    /* NEVER A SECRET, and the guard is deliberate rather than defensive: a credential is the one thing the
     * recommended flow will not put into a form on the user's behalf, even where one is sitting in a file it has
     * read. A prefill for a field the card does not declare, or one whose value the card fixes, is dropped. */
    for (const [key, value] of Object.entries(prefill)) {
        const field = entry.fields.find((candidate) => candidate.key === key);
        if (field !== undefined && field.secret !== true && field.value === undefined) {
            values[key] = value;
        }
    }
    return values;
};

// The fields a user types a credential into: never echoed back by the daemon, never filled in on their behalf.
export const secretFields = (entry: CapabilityCatalogEntry): readonly CapabilityField[] =>
    entry.fields.filter((field) => field.secret === true && field.value === undefined);

/* WHAT AN IMPORTED FORTICLIENT CONNECTION ANSWERS, and what it deliberately blanks first.
 *
 * FortiClient encrypts stored credentials with a machine-bound key, so no secret can ever come out of the file,
 * and anything already in those fields belongs to a DIFFERENT connection (or to dev autofill, which remembers
 * the last value pasted for this card). Carrying that over silently submits the wrong credential, which is
 * exactly how an EncX blob reached the daemon and got rejected. So every secret is blanked and the user types
 * the one that belongs to what they picked. */
export const forticlientAnswers = (fields: readonly CapabilityField[], connection: ForticlientConnection): FormValues => {
    const answers: FormValues = {};
    for (const field of fields) {
        if (field.secret === true) {
            answers[field.key] = ``;
        }
    }
    answers[`provider`] = connection.provider;
    answers[`server`] = connection.server;
    answers[`port`] = String(connection.port);
    answers[`username`] = connection.username ?? ``;
    if (connection.provider !== `ipsec`) {
        return answers;
    }
    answers[`localId`] = connection.localId ?? ``;
    answers[`aggressive`] = connection.aggressive === true ? `on` : `off`;
    answers[`ikeVersion`] = `1`;
    // Phase 2 decides whether quick mode can succeed at all, carry both across from the export.
    answers[`pfs`] = connection.pfs === false ? `off` : `on`;
    if (connection.dhGroup !== undefined) {
        answers[`dhGroup`] = connection.dhGroup;
    }
    return answers;
};

/* THE CONFIG THE DAEMON IS SENT. Fixed fields are baked in, gated-out ones are skipped (the SSH credential of
 * the unchosen auth branch), and an empty answer carries no key at all rather than an empty one.
 *
 * No `tier` and no `registry` are set from this form, and that is correct rather than an omission: both are the
 * REGISTRY's facts about a listing, not something anybody types, and this form only ever installs from a URL its
 * user supplied, whose tier this browser has no way to know, and whose updates and advisories the daemon
 * rightly compares against the official registry when no origin was recorded. A listing installed from Discover
 * carries both from the row it was picked on. */
export const buildConfig = (entry: CapabilityCatalogEntry, values: FormValues, stored: StoredSecrets = NOTHING_STORED): Record<string, string> =>
    fieldConfig(entry, (field) => {
        if (!fieldApplies(field, values)) {
            return undefined;
        }
        // The marker, not the value and not a hole: an omitted key would be the daemon's "this connection no
        // longer has one", which for a required credential fails the schema and for an optional one erases it.
        if (keepsSecret(field, values[field.key], stored)) {
            return VAULTED;
        }
        const value = (values[field.key] ?? ``).trim();
        return value.length > 0 ? value : undefined;
    });

/* The config as capabilityEffects sees it: fixed fields baked in (like buildConfig), the rest from whichever
 * source the caller is asking about, the live form values, the card's declared defaults (grid badges), or an
 * instance's echoed config. */
export const fieldConfig = (entry: CapabilityCatalogEntry, source: (field: CapabilityField) => string | undefined): Record<string, string> => {
    const config: Record<string, string> = {};
    for (const field of entry.fields) {
        const value = field.value ?? source(field);
        if (value !== undefined) {
            config[field.key] = value;
        }
    }
    return config;
};
