import { bindingWindow, type OauthAccount } from "@intentic/sandbox-contract";
import { computed, type ComputedRef, ref, watch } from "vue";
import { useAgents } from "../../../agents/fleet/useAgents";
import { useSandboxSettings } from "../../../sandbox/overview/useSandboxSettings";
import { effectivePolicy, sandboxPolicy } from "../../run/turnBreak";
import type { Conversation } from "../../session/conversation";
import { fallbackAccount, fallbackLabel } from "../../session/limitFallback";
import { askLimitReset, claimLimitReset, limitResetFor, limitResetNote } from "../../session/limitReset";
import { usageStatusFor } from "../../session/usageStatus";
import type { SendIntent } from "../../composer/composerIntent";

// The scheduled send's two halves outside the ladder: arming the conversation's limit answer, and the ways to skip the
// wait altogether (another account with room, the provider's weekly reset of the five-hour window). The same readings
// the limit card offers after a refusal (ChatContinueStrip), offered before one instead.

// How long a chat's first message may take to register it before the answer is written anyway (and refused, if not).
const REGISTER_WAIT_MS = 10_000;

/**
 * Sets this conversation's limit answer to `resend` unless it already arms something (`move` implies the appointment),
 * writing it as a clear-to-inherit when the sandbox-wide answer already says `resend`. "Stay on" by design: the reader
 * has just said what this chat should do at the wall, and the limit card shows the answer and switches it back.
 */
export const useLimitResend = (conversation: () => Conversation) => {
    const { agentById, setBreakPolicy } = useAgents();
    const { settings } = useSandboxSettings();
    // A chat's first message is what registers it, so the write waits for the entry rather than naming an unknown id.
    const registered = (id: string): Promise<void> =>
        new Promise((resolve) => {
            if (agentById(id) !== undefined) {
                resolve();
                return;
            }
            const timer = setTimeout(done, REGISTER_WAIT_MS);
            const stop = watch(
                () => agentById(id) !== undefined,
                (known) => known && done(),
            );
            function done(): void {
                clearTimeout(timer);
                stop();
                resolve();
            }
        });
    return async (): Promise<void> => {
        const id = conversation().conversationId;
        await registered(id);
        if (effectivePolicy(`limit`, agentById(id), settings.value) !== `wait`) {
            return;
        }
        await setBreakPolicy(id, `limit`, sandboxPolicy(`limit`, settings.value) === `resend` ? null : `resend`);
    };
};

export interface ScheduledWaysHost {
    readonly conversation: () => Conversation;
    readonly intent: ComputedRef<SendIntent>;
    readonly serving: ComputedRef<string | undefined>;
    readonly accounts: ComputedRef<readonly OauthAccount[]>;
    // The composer's press; `now` skips the scheduling, since each way here has just made room itself.
    readonly submit: (options?: { readonly now?: boolean }) => void;
}

export const useScheduledWays = (host: ScheduledWaysHost) => {
    const scheduled = computed(() => host.intent.value === `scheduled`);
    const model = computed(() => {
        const id = host.conversation().selection.model.value;
        return id === `` ? undefined : { id };
    });

    // Another connected account with room for this model, by the same pick the daemon's own limit move makes.
    const fallback = computed(() =>
        scheduled.value ? fallbackAccount(host.conversation().selection.provider.value, host.serving.value, host.accounts.value, model.value) : undefined,
    );

    // The provider's weekly reset reopens only the five-hour window: offered only when that is the pool in the way, and
    // only once the provider itself says yes (never inferred from a full meter). Asked once per account, when the button
    // turns into a schedule: the endpoint rate-limits hard.
    const resetAccount = computed(() => {
        const id = host.serving.value;
        if (!scheduled.value || id === undefined) {
            return undefined;
        }
        const window = bindingWindow(usageStatusFor(host.conversation().selection.provider.value, id, model.value), model.value);
        return window?.kind === `five_hour` ? id : undefined;
    });
    watch(resetAccount, (id) => void askLimitReset(id, host.conversation().box.value), { immediate: true });
    const canReset = computed(() => resetAccount.value !== undefined && limitResetFor(resetAccount.value)?.available === true);

    const open = ref(false);
    const resetting = ref(false);
    // Why the last reset didn't open the window, until the reader tries something else.
    const note = ref<string>();
    const ways = computed(() => fallback.value !== undefined || canReset.value);
    // An emptied menu closes, so nothing floats over a composer that has gone back to a plain Send.
    watch(ways, (any) => {
        if (!any) {
            open.value = false;
        }
    });
    watch(scheduled, () => {
        note.value = undefined;
    });

    // Moves the chat to that account the way the picker would, then sends at once: nothing is spent there to wait on.
    const sendOnFallback = (): void => {
        const target = fallback.value;
        if (target === undefined) {
            return;
        }
        open.value = false;
        host.conversation().selection.apply({ kind: `selectAccount`, account: target.id });
        host.submit({ now: true });
    };

    // Spends the week's reset, then sends at once; anything short of a reset leaves the draft and says why. `not_limited`
    // means the window already reopened, which is a reason to send, not to stop.
    const resetAndSend = async (): Promise<void> => {
        const id = resetAccount.value;
        if (id === undefined || resetting.value) {
            return;
        }
        resetting.value = true;
        note.value = undefined;
        try {
            const claim = await claimLimitReset(id, host.conversation().box.value);
            if (claim.result === `reset` || claim.result === `not_limited`) {
                open.value = false;
                host.submit({ now: true });
                return;
            }
            note.value = limitResetNote(claim);
        } finally {
            resetting.value = false;
        }
    };

    return {
        open,
        ways,
        fallbackName: computed(() => (fallback.value === undefined ? undefined : fallbackLabel(fallback.value))),
        canReset,
        resetting,
        note,
        sendOnFallback,
        resetAndSend,
    };
};
