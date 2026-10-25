import { type InjectionKey, provide, type Ref, ref } from "vue";

// A press on a composer that has nothing to send with (Enter, or hands-free voice ending a sentence) does not open
// anything: it points at the one way on, the account notice's own press, which shakes once per nudge. The pane counts
// the nudges and the notice above its composer reads them (ChatAccountPanel.vue).
export const ACCOUNT_NUDGE: InjectionKey<Readonly<Ref<number>>> = Symbol(`intentic.chat-account-nudge`);

/** Provides a pane's nudge count to the notices under it, and returns the nudge. */
export const provideAccountNudge = (): (() => void) => {
    const nudges = ref(0);
    provide(ACCOUNT_NUDGE, nudges);
    return () => {
        nudges.value += 1;
    };
};
