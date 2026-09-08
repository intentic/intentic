import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { type CapabilityField, fieldApplies } from "@intentic/extension-manifest";
import {
    type ForticlientConnection,
    isForticlientCiphertext,
    LOCAL_MODEL_WINDOW_MAX,
    LOCAL_MODEL_WINDOW_MIN,
    VAULTED,
} from "@intentic/sandbox-contract";

// A card declares fields; this module decides which are shown, what an answer means, and what
// reaches the daemon, as plain functions over the form's values. The only difference between add and
// edit: on edit, a blank secret box for a `stored` key means keep it, not unanswered.

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const URL_RE = /^https?:\/\/.+/i;

// Repairs a typed name into a valid one instead of refusing it (case kept); only a name with nothing
// salvageable left is refused.
export const cleanName = (raw: string): string =>
    raw
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/gu, `-`)
        .replace(/[-_]{2,}/g, `-`)
        .replace(/^[-_]+/, ``)
        .replace(/[-_]+$/, ``);

/** The form's values, keyed by field; every value, including a switch, is a string ("on"/"off"). */
export type FormValues = Record<string, string>;

// The credential keys the connection being edited already holds; empty when adding.
export type StoredSecrets = ReadonlySet<string>;
// Default for every rule below: nothing stored, i.e. an add.
const NOTHING_STORED: StoredSecrets = new Set<string>();

/** A blank box that means "keep what's there": this field holds a credential the browser was never shown. */
export const keepsSecret = (field: CapabilityField, value: string | undefined, stored: StoredSecrets): boolean =>
    field.secret === true && (value ?? ``).trim().length === 0 && stored.has(field.key);

// undefined means valid, here and in every rule below; the only unanswerable name is one with
// nothing left after cleanName repairs it.
export const nameError = (name: string): string | undefined => (cleanName(name).length === 0 ? `Name is required.` : undefined);

// Each rule refuses a value that is actually present; emptiness is handled separately by
// fieldMissing. The first rule to object is what the field shows.
type FieldRule = (field: CapabilityField, value: string) => string | undefined;

const RULES: readonly FieldRule[] = [
    (field, value) => (!field.secret && field.key.toLowerCase().includes(`url`) && !URL_RE.test(value) ? `Enter a valid URL (e.g. https://…).` : undefined),
    // Ciphertext lifted straight from a FortiClient config; the daemon rejects it, so refuse it before
    // the round trip.
    (_field, value) =>
        isForticlientCiphertext(value)
            ? `FortiClient encrypted this with a key tied to the machine that exported it: it can't be used. Enter the real value.`
            : undefined,
    (field, value) => {
        if (field.key !== `port`) {
            return undefined;
        }
        const port = Number(value);
        return Number.isInteger(port) && port >= 1 && port <= 65_535 ? undefined : `Enter a valid port number (1–65535).`;
    },
    // Context token bounds are imported from the schema, not restated, so box and schema cannot disagree.
    (field, value) => {
        if (field.key !== `contextTokens`) {
            return undefined;
        }
        const tokens = Number(value);
        return Number.isInteger(tokens) && tokens >= LOCAL_MODEL_WINDOW_MIN && tokens <= LOCAL_MODEL_WINDOW_MAX
            ? undefined
            : `Enter a whole number of tokens (${LOCAL_MODEL_WINDOW_MIN.toLocaleString()}–${LOCAL_MODEL_WINDOW_MAX.toLocaleString()}).`;
    },
];

// fieldMissing: an untouched required field, shown as a quiet "required" only after a submit attempt.
// fieldInvalid: a present but malformed value, flagged on blur immediately.
export const fieldMissing = (field: CapabilityField, value: string | undefined, stored: StoredSecrets = NOTHING_STORED): boolean =>
    !keepsSecret(field, value, stored) && field.optional !== true && (value ?? ``).trim().length === 0;

export const fieldInvalid = (field: CapabilityField, value: string | undefined, stored: StoredSecrets = NOTHING_STORED): string | undefined => {
    // Left alone on an edit, there is nothing to refuse about a value the user is keeping.
    if (keepsSecret(field, value, stored)) {
        return undefined;
    }
    const trimmed = (value ?? ``).trim();
    if (trimmed.length === 0) {
        return undefined;
    }
    for (const rule of RULES) {
        const message = rule(field, trimmed);
        if (message !== undefined) {
            return message;
        }
    }
    return undefined;
};

// The two folded back together, for the callers that only ask "is this field fine".
export const fieldError = (field: CapabilityField, value: string | undefined, stored: StoredSecrets = NOTHING_STORED): string | undefined =>
    fieldMissing(field, value, stored) ? `This field is required.` : fieldInvalid(field, value, stored);

// The green check, shown only for fields with a rule that can genuinely vouch for the value (sha,
// URL, port); free text earns none.
export const fieldVerified = (field: CapabilityField, value: string | undefined): boolean => {
    const trimmed = (value ?? ``).trim();
    if (trimmed.length === 0 || field.secret === true || field.options !== undefined || field.boolean === true) {
        return false;
    }
    if (field.key === `ref`) {
        return isCommitSha(trimmed);
    }
    if (field.key === `port` || field.key === `contextTokens` || field.key.toLowerCase().includes(`url`)) {
        return fieldInvalid(field, trimmed) === undefined;
    }
    return false;
};

// Fields shown as inputs: const-valued fields are baked in, not rendered; when-gated ones only while
// `fieldApplies` (the daemon's own install-time check) holds.
export const shownFields = (entry: CapabilityCatalogEntry, values: FormValues): readonly CapabilityField[] =>
    entry.fields.filter((field) => field.value === undefined && fieldApplies(field, values));

// Judged by total label width, not option count: short labels fit inline, longer ones wrap or stack.
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

// True when every visible field is answered (a stored credential counts) and cleanName(name) is a
// valid name.
export const formComplete = (entry: CapabilityCatalogEntry, values: FormValues, name: string, stored: StoredSecrets = NOTHING_STORED): boolean =>
    NAME_RE.test(cleanName(name)) &&
    shownFields(entry, values).every(
        (field) => field.optional === true || keepsSecret(field, values[field.key], stored) || (values[field.key] ?? ``).trim().length > 0,
    );

// The only `ref` an extension install may pin; a branch name would let code move after approval was
// given.
const SHA_RE = /^[0-9a-f]{40}$/u;

export const isCommitSha = (value: string | undefined): boolean => SHA_RE.test(value ?? ``);

// Seed order: card defaults, then live config (never a credential), then workspace prefill; dev
// autofill layers on in ./devSecrets. A switch seeds to "off", not empty, so it's always answered.
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
    // Never seeds a secret; a prefill for a field the card doesn't declare, or one the card fixes, is
    // dropped.
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

// Blanks every secret first: FortiClient's stored credentials are encrypted with a machine-bound key
// and cannot be exported, and any value left in those fields would belong to a different connection.
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
    // PFS controls whether quick mode can succeed; carried across from the export.
    answers[`pfs`] = connection.pfs === false ? `off` : `on`;
    if (connection.dhGroup !== undefined) {
        answers[`dhGroup`] = connection.dhGroup;
    }
    return answers;
};

// Fixed and gated-out fields are baked in or skipped as fieldApplies decides; an empty answer sends
// no key. Sets no `tier` or `registry`: those are the registry's facts, not something typed here.
export const buildConfig = (entry: CapabilityCatalogEntry, values: FormValues, stored: StoredSecrets = NOTHING_STORED): Record<string, string> =>
    fieldConfig(entry, (field) => {
        if (!fieldApplies(field, values)) {
            return undefined;
        }
        // Sends the marker, not a hole: an omitted key means "no longer has one", erasing or failing the
        // credential.
        if (keepsSecret(field, values[field.key], stored)) {
            return VAULTED;
        }
        const value = (values[field.key] ?? ``).trim();
        return value.length > 0 ? value : undefined;
    });

// Config as capabilityEffects sees it: fixed fields baked in, the rest read from whatever source the
// caller passes (form values, card defaults, or an instance's echoed config).
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
