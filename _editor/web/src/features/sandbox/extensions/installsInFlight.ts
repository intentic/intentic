import { sandboxShallowRef } from "@intentic/extension-api";
import { computed } from "vue";

// Installs and updates started from Browse, by listing name. Kept outside the view that starts them: switching to the
// Installed pill unmounts Browse while the clone runs on, and coming back has to show it still running rather than
// offer Install a second time. Per sandbox, since the clone runs in the box it was started on.

const running = sandboxShallowRef<readonly string[]>(() => []);

/** The listings being installed or updated in this sandbox right now. */
export const installsInFlight = computed<ReadonlySet<string>>(() => new Set(running.value));

/** Marks `name` as installing until the returned end is called; ending twice ends it once. */
export const beginInstall = (name: string): (() => void) => {
    running.value = [...running.value, name];
    let ended = false;
    return (): void => {
        if (ended) {
            return;
        }
        ended = true;
        const at = running.value.indexOf(name);
        running.value = at === -1 ? running.value : running.value.toSpliced(at, 1);
    };
};
