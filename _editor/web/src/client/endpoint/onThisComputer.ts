import { ref } from "vue";
import { z } from "zod";
import { ON_THIS_COMPUTER_KEY, onAccountCleared, storedJson, storeJson } from "../../app/storage/browserStorage";
import type { Endpoint } from "./endpoint";

// WHICH SANDBOXES THIS BROWSER HAS REACHED OVER LOOPBACK, kept past the visit that proved it. The transport only
// probes the active sandbox, so without a memory every other row in the switcher falls back to the coarse "your own
// machine" and only the selected one says "this computer". A loopback answer is proof the container runs here; a
// tunnel answer while loopback stayed silent is proof it does not; a sandbox that answered nowhere (asleep, stopped)
// says nothing either way, so it keeps what was known.

const IdsSchema = z.array(z.string());

// allow(module-state): one browser's memory, mirrored so every row redraws on a write
const seen = ref<ReadonlySet<string>>(new Set(storedJson(ON_THIS_COMPUTER_KEY, IdsSchema) ?? []));

onAccountCleared(() => {
    seen.value = new Set();
});

const write = (next: ReadonlySet<string>): void => {
    seen.value = next;
    storeJson(ON_THIS_COMPUTER_KEY, [...next]);
};

// Records what a finished probe proved about where a sandbox runs.
export const rememberRoute = (sandboxId: string, endpoint: Endpoint): void => {
    if (endpoint.unanswered === true) {
        return;
    }
    const local = endpoint.kind !== `public`;
    if (local === seen.value.has(sandboxId)) {
        return;
    }
    const next = new Set(seen.value);
    if (local) {
        next.add(sandboxId);
    } else {
        next.delete(sandboxId);
    }
    write(next);
};

// Whether this browser last found the sandbox on this very computer. Reactive: read inside a computed or a template.
export const seenOnThisComputer = (sandboxId: string): boolean => seen.value.has(sandboxId);
