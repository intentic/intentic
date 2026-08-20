import { computed, ref } from "vue";
import { storedKeys, storedValue, storeValue } from "../browserStorage";
import { activeSandboxId } from "./activeSandbox";

/* WHETHER THIS BROWSER MAY REACH FOR A SANDBOX RUNNING ON THIS COMPUTER, asked in the app's own words, once,
 * before the browser asks in its own.
 *
 * The loopback shortcut (endpoint.ts) is the only thing in this app that touches the machine the browser runs
 * on, and Chrome now gates that behind a Local Network Access permission. Left alone, that dialog arrives
 * unasked-for at first paint, says the app wants to access devices on the user's local network, and names no
 * benefit whatsoever. The honest reading, by someone who requested none of it, is that the app is looking
 * around their machine.
 *
 * It is not. It fetches one address, on a port derived from their own sandbox's connect token, and adopts what
 * answers only if it names that sandbox. But none of that is on screen, and a permission dialog is the worst
 * possible place to learn what a feature is for. So the app states the benefit first, in one sentence, and
 * reaches for the address only after a yes, which means the browser's dialog, when it comes, is the answer to
 * a question the user has just been asked rather than an interruption they cannot place.
 *
 * THE TWO ANSWERS ARE REMEMBERED AT DIFFERENT SCOPES, because they answer different questions.
 *
 * A yes is about this BROWSER. It is the same grant Chrome itself keeps per origin, so once given, every
 * sandbox may use the shortcut and nothing asks again, asking a second time would be asking for something we
 * already have.
 *
 * A no is about THIS SANDBOX. The real question underneath is "is this one on this computer", and for a
 * sandbox on a colleague's desktop the answer is a permanent no that should never be raised again. But it is
 * not permanent for the USER: the day they set a new sandbox up on the laptop in front of them, the answer
 * changes, and scoping the no to the sandbox is what lets that day arrive on its own, no settings page to
 * find, and no re-prompting about the sandbox they already said no to. */

// This browser's yes. One key, no sandbox in it: the permission it stands for is the origin's, not a
// sandbox's.
const ALLOWED_KEY = `intentic.localShortcut`;
// One key per sandbox that was refused. A prefix rather than a list so a refusal is a single independent
// write, and a sandbox that is deleted leaves one dead key instead of corrupting a shared value.
const DECLINED_PREFIX = `intentic.localShortcut.declined.`;

const allowed = ref(storedValue(ALLOWED_KEY) === `yes`);
const declined = ref<ReadonlySet<string>>(new Set(storedKeys(DECLINED_PREFIX).map((key) => key.slice(DECLINED_PREFIX.length))));

/* The sandbox the question was raised for, if any. One at a time and never queued: the question is as much
 * about this browser as about the sandbox, so a second copy behind the first would be the same question twice.
 */
const asking = ref<string | undefined>(undefined);

/* …and what is actually ASKABLE, which is the same thing only while that sandbox is the one on screen. A
 * switch away strands the question, the user is now looking at another sandbox, and a card asking to speed up
 * something they have navigated off is a card about nothing. It is dropped rather than re-pointed: whether the
 * sandbox they switched TO is worth asking about is the probe's call, and it makes it on arrival. */
const question = computed(() => (asking.value === activeSandboxId.value ? asking.value : undefined));

export type ShortcutAnswer = "unasked" | "allowed" | "declined";

export const shortcutAnswer = (sandboxId: string): ShortcutAnswer =>
    allowed.value ? `allowed` : declined.value.has(sandboxId) ? `declined` : `unasked`;

export function useLocalShortcut() {
    // Raise the question for a sandbox. Callers gate on `shortcutAnswer` first, so this never re-asks something
    // already answered; it is separate from the answer so the probe stays the only thing that decides WHEN.
    const ask = (sandboxId: string): void => {
        asking.value = sandboxId;
    };

    /* Yes, kept for the browser, because that is the scope of the permission it is really about. The caller
     * re-runs the probe: the sandbox the question was raised for is still the active one, and making the user
     * wait for a reconnect to feel the speed-up they just agreed to would waste the only moment they are
     * thinking about it. */
    const allow = (): void => {
        allowed.value = true;
        storeValue(ALLOWED_KEY, `yes`);
        asking.value = undefined;
    };

    // No, kept for this sandbox only (see the header). Nothing is retried and nothing degrades: the tunnel is
    // the address every sandbox already had.
    const decline = (sandboxId: string): void => {
        declined.value = new Set([...declined.value, sandboxId]);
        storeValue(`${DECLINED_PREFIX}${sandboxId}`, `yes`);
        asking.value = undefined;
    };

    return { question, ask, allow, decline };
}
