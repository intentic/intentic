import { computed, ref } from "vue";
import { storedKeys, storedValue, storeValue } from "../../../lib/browserStorage";
import { activeSandboxId } from "../overview/activeSandbox";
import { loopbackPermission } from "./loopbackPermission";

// Whether this browser may reach a sandbox on the user's own device, asked in the app's own words before
// Chrome's dialog does. States the benefit first so that dialog, when it comes, answers a question already
// asked. A record of what the user was told, not of the permission itself; it decides nothing once Chrome is
// past `prompt`.

// This browser's yes: one key, no sandbox in it, since the grant is the origin's.
const ALLOWED_KEY = `intentic.localShortcut`;
// One key per refused sandbox; a prefix keeps each refusal an independent write.
const DECLINED_PREFIX = `intentic.localShortcut.declined.`;

const allowed = ref(storedValue(ALLOWED_KEY) === `yes`);
const declined = ref<ReadonlySet<string>>(new Set(storedKeys(DECLINED_PREFIX).map((key) => key.slice(DECLINED_PREFIX.length))));

// The sandbox the question was raised for, if any. One at a time: the question is as much about this browser
// as about the sandbox, so a second one queued behind would repeat it.
const asking = ref<string | undefined>(undefined);

// Askable only while that sandbox is still active; a switch away drops the question rather than re-pointing
// it, since a card about the sandbox just left is a card about nothing.
const question = computed(() => (asking.value === activeSandboxId.value ? asking.value : undefined));

export type ShortcutAnswer = "unasked" | "allowed" | "declined";

// Browser's own answer first: `denied` ends it, `granted`/`ungated` outrank a stored no, and only at `prompt`
// do the stored answers decide. Async because the Permissions API is; called on reconnect, not on a frame.
export const shortcutAnswer = async (sandboxId: string): Promise<ShortcutAnswer> => {
    const browser = await loopbackPermission();
    if (browser === `denied`) {
        return `declined`;
    }
    if (browser === `granted` || browser === `ungated`) {
        return `allowed`;
    }
    return allowed.value ? `allowed` : declined.value.has(sandboxId) ? `declined` : `unasked`;
};

export function useLocalShortcut() {
    // Raises the question; callers gate on shortcutAnswer first so this never re-asks something already answered.
    const ask = (sandboxId: string): void => {
        asking.value = sandboxId;
    };

    // Kept for the browser, matching the permission's own scope. The caller re-probes immediately rather than
    // waiting for the next reconnect.
    const allow = (): void => {
        allowed.value = true;
        storeValue(ALLOWED_KEY, `yes`);
        asking.value = undefined;
    };

    // Kept for this sandbox only; nothing is retried, since the tunnel is the address every sandbox already had.
    const decline = (sandboxId: string): void => {
        declined.value = new Set([...declined.value, sandboxId]);
        storeValue(`${DECLINED_PREFIX}${sandboxId}`, `yes`);
        asking.value = undefined;
    };

    return { question, ask, allow, decline };
}
