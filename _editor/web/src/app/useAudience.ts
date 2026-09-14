import { computed, type ComputedRef, type Ref, ref } from "vue";
import { definePreference } from "@intentic/ui/preference";
import { storedValue, storeValue } from "../lib/browserStorage";

// Who the screen is written for. A developer reads git's own words (branch, land, commit, diff) and every panel; a
// maker reads plain ones (draft, accept, version, what changed) over the same mechanisms, with tooling files, the index
// and the terminal out of the way. A preference of the person looking, kept per browser like theme and skin: the daemon
// never sees it, and nothing an agent does depends on it.

export type Audience = "developer" | "maker";

const STORAGE_KEY = `ui-audience`;

const isAudience = (value: unknown): value is Audience => value === `developer` || value === `maker`;

// Unset reads as developer, so everyone who arrived before the question existed keeps the screens they had.
const audience: Ref<Audience> = definePreference<Audience>({
    key: STORAGE_KEY,
    read: (raw) => (isAudience(raw) ? raw : `developer`),
    write: (value) => value,
});

// Whether this browser has answered the question; the arrival card asks once and never again.
const chosen = ref(isAudience(storedValue(STORAGE_KEY)));

const maker: ComputedRef<boolean> = computed(() => audience.value === `maker`);

// Written to storage here as well as through the preference, since answering "developer" leaves the value where it
// already was and a preference only persists a change; the answer itself is the fact the arrival card keeps.
const setAudience = (value: Audience): void => {
    audience.value = value;
    storeValue(STORAGE_KEY, value);
    chosen.value = true;
};

export function useAudience() {
    return { audience, maker, chosen, setAudience };
}
