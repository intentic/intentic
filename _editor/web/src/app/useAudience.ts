import { computed, type ComputedRef, type Ref, ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { storedValue, storeValue } from "../lib/browserStorage";

// Who the screen is written for. A developer reads git's own words (branch, land, commit, diff) and every panel; a
// maker reads plain ones (draft, accept, version, what changed) over the same mechanisms, with tooling files, the index
// and the terminal out of the way. Nothing an agent does depends on it.
//
// The sandbox keeps each person's answer too (`settings.audience`, audienceSync.ts), so the desktop app and a browser tab
// on the same sandbox name one button one way, while two people on it keep their own. This browser's copy is what paints
// before the sandbox answers, what a daemon too old to keep one leaves in charge, and what is handed over once when the
// sandbox keeps none for this person yet.

export type Audience = "developer" | "maker";

const STORAGE_KEY = `ui-audience`;

const isAudience = (value: unknown): value is Audience => value === `developer` || value === `maker`;

// Unset reads as developer, so everyone who arrived before the question existed keeps the screens they had.
const audience: Ref<Audience> = definePreference<Audience>({
    key: STORAGE_KEY,
    read: (raw) => (isAudience(raw) ? raw : `developer`),
    write: (value) => value,
});

// Whether this browser has answered the question, or adopted a sandbox's answer; the arrival card asks once and never again.
// allow(module-state): whether this browser answered the audience question, asked once per browser
const chosen = ref(isAudience(storedValue(STORAGE_KEY)));

const maker: ComputedRef<boolean> = computed(() => audience.value === `maker`);

// Where an answer is kept beyond this browser, once the app has registered it (audienceSync.ts); absent in a window that
// never attached a sandbox, and in tests.
let keeper: ((value: Audience) => void) | undefined;

export const keepAudienceWith = (keep: ((value: Audience) => void) | undefined): void => {
    keeper = keep;
};

// Written to storage here as well as through the preference, since answering "developer" leaves the value where it
// already was and a preference only persists a change; the answer itself is the fact the arrival card keeps.
const remember = (value: Audience): void => {
    audience.value = value;
    storeValue(STORAGE_KEY, value);
    chosen.value = true;
};

// Somebody answering here: this browser, and the sandbox with it.
const setAudience = (value: Audience): void => {
    remember(value);
    keeper?.(value);
};

// The sandbox's kept answer taken as this browser's own: remembered like an answer, never sent back.
export const adoptAudience = (value: Audience): void => remember(value);

// What this browser does once it has read what the sandbox keeps: take a kept answer it doesn't already hold, hand its
// own over when the sandbox keeps none and this browser has answered, and otherwise nothing.
export const audienceStep = (kept: Audience | undefined, local: Audience, answered: boolean): `adopt` | `offer` | `none` => {
    if (kept !== undefined) {
        return kept === local && answered ? `none` : `adopt`;
    }
    return answered ? `offer` : `none`;
};

export function useAudience() {
    return { audience, maker, chosen, setAudience };
}
