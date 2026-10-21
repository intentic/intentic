import { listen } from "@tauri-apps/api/event";
import { computed, ref } from "vue";
import { type LocalRoster, localRoster } from "../desktop";

// WHO IS SIGNED IN, as the workspace last told the app (`roster.json`, `desktop://roster`): what This computer's card
// for this PC asks the sign-in by. Read once when a window opens, then every roster the workspace sends heard.

/** The account and its sandboxes, once read; undefined before. */
const roster = ref<LocalRoster | undefined>(undefined);

/** Someone is signed in; undefined before the app has said. */
export const signedIn = computed<boolean | undefined>(() => (roster.value === undefined ? undefined : roster.value.account !== null));

let started: Promise<void> | undefined;

/** Read the roster and follow it, once per window. A failed read is the console's: the next roster still arrives. */
export const followRoster = (): Promise<void> =>
    (started ??= (async () => {
        await listen<LocalRoster>(`desktop://roster`, (event) => {
            roster.value = event.payload;
        });
        try {
            roster.value ??= await localRoster();
        } catch (error) {
            console.error(`[roster] who is signed in could not be read:`, error);
        }
    })());
