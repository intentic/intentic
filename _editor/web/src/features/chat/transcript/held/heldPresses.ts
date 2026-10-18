import type { Tip } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { supportsRoute } from "../../../../client/sandbox/useDaemonRoutes";
import { atReopenPhrase, pickUpWhen } from "../../../../models/conversations/endings/pickUp";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";

/* WHAT A MESSAGE THAT DID NOT GO OUT OFFERS, DECIDED ONCE. Every surface that draws one (the held line under its words,
   the bar over the composer, the row under a turn the sandbox kept) asks here, from what stands now rather than from the
   refusal that held it: the account it would go on is spent until a reopen still ahead, so the solid press books it for
   then, whatever held it, and its own press (Send anyway, Send now, Send again) steps back to a quiet one, since the
   reopen is the provider's estimate and the reader may know better. Before 2026-10-18 the held line dropped the
   booking for a memory hold ("about room, not the allowance"), and the other two never read the allowance at all: a
   message held for memory on an account spent until 05:00 offered only Send anyway, which could only be refused. */

/**
 * The press that books a held message, or a kept turn, for the spent account's reopen; undefined while none is ahead.
 * `arm` sets the conversation's limit answer to send again (scheduledSend.ts, useLimitResend), passed by the surfaces
 * that book words, which already read that answer.
 */
export const useReopenPress = (active: () => boolean, arm?: () => Promise<void>) => {
    const t = useT();
    const { conversation, spentReopensAt } = usePaneView();
    const spentAt = computed(() => (spentReopensAt.value === undefined ? undefined : spentReopensAt.value * 1_000));
    const now = useNow(() => active() && spentAt.value !== undefined);
    // Only a sandbox that books can hold anything for the reopen.
    const reopenAt = computed(() => {
        const at = spentAt.value;
        return at === undefined || at <= now.value || !supportsRoute(`agent.queueSchedule`) ? undefined : at;
    });
    const label = computed(() =>
        reopenAt.value === undefined
            ? ``
            : atReopenPhrase({ at: (when) => t(`chat.chatHeld.sendAt`, { when }), in: (when) => t(`chat.chatHeld.sendIn`, { when }) }, reopenAt.value, now.value),
    );
    const hint = computed((): Tip => ({
        title: t(`chat.chatHeld.sendAtTitle`),
        rows: reopenAt.value === undefined ? [] : [{ label: t(`chat.composerIntent.sendsAt`), value: pickUpWhen(reopenAt.value, now.value) }],
        note: t(`chat.composerIntent.hintScheduledHeld`),
    }));
    // What the quiet press that sends it now says about the reopen ahead: the allowance may still refuse it. Undefined
    // with no reopen ahead, where the press keeps its own hover.
    const sendNowHint = computed((): Tip | undefined =>
        reopenAt.value === undefined ? undefined : { title: t(`chat.chatHeld.sendNowTitle`), note: t(`chat.chatHeld.sendNowSpent`) },
    );
    // The held words, booked for the reopen: they stand under the scheduled line with their own Change and Send now. The
    // limit answer is set to send them again too, as for any scheduled send, should the provider name that reopen early.
    const bookWords = (ids: readonly string[]): void => {
        const at = reopenAt.value;
        if (at === undefined) {
            return;
        }
        // allow(silent-catch): the write is optimistic and rolls back on failure, so the limit card's control saying `wait` is the report.
        void arm?.().catch(() => undefined);
        void conversation.value.turn.reschedule({ sendAt: at }, ids);
    };
    // A turn the sandbox kept has no words in the queue: a Continue booked for the reopen runs it again then, as it was.
    // Only a sandbox that books a Continue can; undefined elsewhere, where the kept turn keeps its own press alone.
    const bookContinue = computed(() =>
        reopenAt.value === undefined || !supportsRoute(`agent.queueContinue`)
            ? undefined
            : (): void => {
                  const at = reopenAt.value;
                  if (at !== undefined) {
                      void conversation.value.turn.scheduleContinue({ sendAt: at });
                  }
              },
    );
    return { reopenAt, label, hint, sendNowHint, bookWords, bookContinue };
};
