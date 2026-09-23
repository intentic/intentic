import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { type CapabilityField, fieldApplies } from "@intentic/extension-manifest";
import {
    type CapabilityKind,
    type ForticlientConnection,
    isForticlientCiphertext,
    LOCAL_MODEL_WINDOW_MAX,
    LOCAL_MODEL_WINDOW_MIN,
    VAULTED,
} from "@intentic/sandbox-contract";

// A tile declares fields; this module decides which are shown, what an answer means, and what
// reaches the daemon, as plain functions over the form's values. The only difference between add and
// edit: on edit, a blank secret box for a `stored` key means keep it, not unanswered.

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
// End-anchored and whitespace-free: uncheckpointed, a two-line paste passed and `fieldVerified` then put a green tick on
// it, which is worse than no tick. Parsed as well as matched, so the check stands behind what it vouches for.
const URL_RE = /^https?:\/\/\S+$/i;
const parsesAsUrl = (value: string): boolean => {
    if (!URL_RE.test(value)) {
        return false;
    }
    try {
        return new URL(value).hostname.length > 0;
    } catch {
        return false;
    }
};

// Repairs a typed name into a valid one instead of refusing it (case kept); only a name with nothing
// salvageable left is refused. Accents are folded to their base letter rather than dropped: deleting the
// é from `Café` leaves `Caf`, a different word, where folding leaves `Cafe`.
export const cleanName = (raw: string): string =>
    raw
        .trim()
        .normalize(`NFKD`)
        .replace(/\p{M}+/gu, ``)
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
// nothing left after cleanName repairs it. A name that is present but unusable says so as itself:
// "required" would be false in front of a box the user can see text in.
export const nameError = (name: string): string | undefined => {
    if (cleanName(name).length > 0) {
        return undefined;
    }
    return name.trim().length === 0 ? `Name is required.` : `This name has no Latin letters or digits to use. Try a romanised name.`;
};

// Each rule refuses a value that is actually present; emptiness is handled separately by
// fieldMissing. The first rule to object is what the field shows.
type FieldRule = (field: CapabilityField, value: string) => string | undefined;

const RULES: readonly FieldRule[] = [
    (field, value) =>
        !field.secret && field.key.toLowerCase().includes(`url`) && !parsesAsUrl(value) ? `Enter a valid URL (e.g. https://…).` : undefined,
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

/** Whether a box has been left (blurred) and whether a submit was refused: what decides how loudly it may object. */
export interface FieldVisit {
    readonly touched: boolean;
    readonly attempted: boolean;
}

// Refusals split by severity: `alarm` is red (a malformed value, or after a refused submit, a required empty box);
// `quiet` is the muted "Required" for a box merely tabbed past. Silent until the box is left or a submit refused.
export const fieldRefusal = (
    field: CapabilityField,
    value: string | undefined,
    stored: StoredSecrets,
    visit: FieldVisit,
): { readonly alarm: string | undefined; readonly quiet: boolean } => {
    if (!visit.touched && !visit.attempted) {
        return { alarm: undefined, quiet: false };
    }
    const missing = fieldMissing(field, value, stored);
    return {
        alarm: fieldInvalid(field, value, stored) ?? (visit.attempted && missing ? `This field is required.` : undefined),
        quiet: !visit.attempted && missing,
    };
};

// An empty credential box's placeholder: the tile's own on add, or "already set, leave blank to keep" over a stored one.
export const placeholderFor = (field: CapabilityField, value: string | undefined, stored: StoredSecrets): string | undefined =>
    keepsSecret(field, value, stored) ? `•••••••••••• already set, leave blank to keep it` : field.placeholder;

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

// A field's answer before anyone gives one: its declared default, and a switch's "off" rather than empty, so it's
// always answered.
export const defaultAnswer = (field: CapabilityField): string => field.default ?? (field.boolean === true ? `off` : ``);

// Advanced fields default correctly for nearly everyone and fold behind one line. A browser tile's fold is a specific
// offer (stored sign-in credentials), not generic "Advanced".
export const advancedLabel = (entry: CapabilityCatalogEntry): string =>
    entry.kind === `browser` ? `Let the agent sign in for you (optional)` : `Advanced`;

// Whether the fold opens on arrival: only when it holds a value other than its default, so an edit never hides what
// it's set to.
export const foldHoldsChoice = (entry: CapabilityCatalogEntry, values: FormValues): boolean =>
    entry.fields.some((field) => field.advanced === true && (values[field.key] ?? ``) !== defaultAnswer(field));

// Whether what refuses a submit sits in the fold, which then has to open: a refusal the reader cannot see is a form
// that looks broken.
export const refusedInFold = (entry: CapabilityCatalogEntry, values: FormValues, stored: StoredSecrets): boolean =>
    shownFields(entry, values).some(
        (field) =>
            field.advanced === true &&
            (fieldMissing(field, values[field.key], stored) || fieldInvalid(field, values[field.key], stored) !== undefined),
    );

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

// Submit's word in the tile's own vocabulary: editing leads, since a pre-filled form must not offer to "Add" a live
// connection; DevOps activates.
export const submitWord = (editing: boolean, kind: CapabilityKind | undefined): string => {
    if (editing) {
        return `Save changes`;
    }
    return kind === `devops` ? `Activate` : `Add`;
};

// Booleans arrive from the daemon's echo as booleans and from the form as "on"/"off".
const echoedAnswer = (value: string | number | boolean | undefined): string => {
    if (typeof value !== `boolean`) {
        return String(value);
    }
    return value ? `on` : `off`;
};

// Seed order: tile defaults, then live config (never a credential), then workspace prefill; dev
// autofill layers on in ./devSecrets.
export const seedValues = (
    entry: CapabilityCatalogEntry,
    live: Record<string, string | number | boolean | undefined> | undefined,
    prefill: Record<string, string>,
): FormValues => {
    const values: FormValues = {};
    for (const field of entry.fields) {
        if (field.value === undefined) {
            values[field.key] = defaultAnswer(field);
        }
    }
    for (const [key, value] of Object.entries(live ?? {})) {
        values[key] = echoedAnswer(value);
    }
    // Never seeds a secret; a prefill for a field the tile doesn't declare, or one the tile fixes, is
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
// caller passes (form values, tile defaults, or an instance's echoed config).
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
