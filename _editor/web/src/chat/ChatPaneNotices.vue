<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { isTrialProvider, TRIAL_NOTICE } from "@intentic/sandbox-contract";
import { trialExhausted } from "../composables/chat/access";
import { useAgents } from "../composables/agents/useAgents";
import { trialStatus } from "../composables/chat/providerCatalog";
import { loadTrialStatus, usePaneView } from "../composables/chat/useChat";
import { useSandbox } from "../composables/sandbox/useSandbox";
import ChatAccountPanel from "./ChatAccountPanel.vue";
import ChatChooseModelButton from "./ChatChooseModelButton.vue";

/* WHAT THIS CHAT'S STANDING IS, said above the composer: the strips that report a state the conversation
 * arrived at by itself, each with the one press that answers it.
 *
 * They are together because they are the same kind of thing and share one slot's worth of the reader's
 * attention, in this order: what this agent IS (archived), and what it can send with (the account gate, the
 * trial, an expired credential). What the composer is FOR stays with the composer: a stopped turn waiting on a
 * press, an armed edit. Those describe the box, not the chat.
 *
 * The outage banner used to live here, which is how a provider failure and a spent allowance came to be two
 * unrelated-looking things on screen. Both are a turn that stopped with work behind it, so both are the
 * continue strip's now (ChatContinueStrip), and this file went back to being about the chat's standing.
 *
 * Everything here reads this pane's own conversation through the injected view, never the focused one: with two
 * chats side by side, a banner about the wrong one is worse than no banner. */

const { conversation, provider, account, accounts, streaming } = usePaneView();
const { reachable } = useSandbox();
const { agentById, archived, loadArchived, restore, busyIds } = useAgents();

/* Archiving an agent closes its chat tab (see the archive note in useAgents), but an archived agent can still be
 * READ in a tab: opened from the archive view, or filed away by the daemon's retention sweep while it sat open.
 * Such a tab must not look live, so the pane says the agent is off the board and offers the one press back. The
 * line also spends its second half on the fact nothing else here could tell the user: a message sent from this
 * tab un-archives the agent (the daemon rebuilds the entry without its marker: registry.begin), which is a
 * feature, not a surprise to walk into.
 *
 * Archived agents ride their own list rather than the live roster, so it has to be asked for. On the REACHABLE
 * seam, not at setup: this pane mounts with the shell, long before the daemon is answering, and a read fired
 * then simply fails: leaving every archived tab in the app looking live until the user happened to open the
 * board. Only while the list is empty, so the one request is not repeated per reconnect once it has landed. */
watch(
    reachable,
    (live) => {
        if (live && archived.value.length === 0) {
            void loadArchived();
        }
    },
    { immediate: true },
);
const activeArchived = computed(() => {
    const agent = agentById(conversation.value.conversationId);
    return agent?.archivedAt === undefined ? undefined : agent;
});

/* What the trial strip says, or nothing at all when this conversation isn't on the trial.
 *
 * Two sentences, because there are two states worth interrupting for and they want opposite things from the
 * reader. While there is allowance left the message LEADS WITH THE COUNT and then discloses: these messages
 * pass through intentic, which the user needs before typing, not after. Once it is spent the disclosure is moot
 * and the only useful sentence is where to go next, which is the free Google sign-in: no daily cap, still no
 * subscription.
 *
 * The count is here and not only on the picker's badge because this is the surface a person is looking at while
 * they spend it. It also carries the one thing that surprises people about this meter: it counts MODEL CALLS,
 * and an agent turn makes several of them, so a first question can cost more than one. Saying so beside the
 * number is cheaper than letting somebody discover it by watching twelve become seven. */

/* NOT ANSWERING IS AN INTERRUPTION; WORKING FOR IT IS NOT, and conflating the two is what put "Free trial
 * degraded. Failed messages are not counted." over answers that had just been written perfectly.
 *
 * The platform publishes one word for the shared key pool (the api's trial-pool.ts). `unavailable` means no key
 * on any model answered, so a turn sent now fails, the user's message is held below and refunded, and Retry is
 * a real press. `degraded` means the pool DID answer, after failing over to another key or another rung, which
 * is the trial working as designed: nothing failed, nothing is held, and there is nothing to retry. It rode the
 * same alarming sentence and the same button anyway, so the strip read as a failure report about a message the
 * user was looking at the answer to. It is a qualifier on the ordinary line now, and only this state gets the
 * strip's attention. */
const trialUnavailable = computed(() => trialStatus.value.health === `unavailable`);
/* SPENT IS THIS STRIP'S ALONE TO SAY. The account gate above would otherwise be up at the same moment (a spent
 * trial cannot send, and that gate reports every provider that cannot send) announcing that the trial "isn't
 * connected in this sandbox", which is both false and an argument with the sentence directly under it. The gate
 * now stands down here, so this strip takes on its door to the model list: used up, the two honest answers are
 * the free Google sign-in and some other model, and both have to be one press away. */
const trialSpent = computed(() => trialExhausted(provider.value));
const trialNotice = computed(() => {
    if (!isTrialProvider(provider.value)) {
        return undefined;
    }
    if (trialSpent.value) {
        return `Free trial used up for today. Connect Google to keep going free.`;
    }
    if (trialUnavailable.value) {
        return `Free trial isn't answering right now. Failed messages are not counted.`;
    }
    const remaining = trialStatus.value.remaining;
    /* NOT A WARNING UNTIL IT IS ONE. This strip went up on the first message of every new account, a count and
     * a "Connect Google" over a chat that had answered nothing yet, and it read as the limit it was about to
     * hit rather than as the ten free turns it had. While more than half the day's allowance is left and the
     * pool is answering cleanly there is nothing to act on, so nothing is said; the picker's badge still names
     * the trial for whoever wants to know. The strained state stays visible at any count, because a slow
     * answer is a thing a person watching one wants explained. */
    const allowance = trialStatus.value.allowance;
    if (allowance > 0 && remaining > allowance / 2 && trialStatus.value.health !== `degraded`) {
        return undefined;
    }
    const left = `${remaining} free ${remaining === 1 ? `message` : `messages`} left today`;
    /* WHICH MODEL ANSWERED, once one has. The trial publishes a single row and picks a real model per message
     * (the platform's trial-ladder.ts), so without this the user cannot tell a weak answer from a fallback rung
     *, and neither can we, reading their bug report. It leads the sentence only after a turn has run: before
     * that there is nothing true to say, and a placeholder would be a promise about a choice not yet made. */
    const served = trialStatus.value.servedModel;
    const answered = served === undefined ? `` : `Last answer: ${served}. `;
    /* The pool having to work for its answers, said last and said mildly: it explains a slow or weaker turn to
     * whoever is watching one, and it is the honest amount of attention a state nobody can act on deserves.
     * The model that actually answered is already named above, which is the specific version of this fact. */
    const strained = trialStatus.value.health === `degraded` ? ` Trial capacity is tight right now, so answers can be slower.` : ``;
    return `${answered}${left}. Each agent step costs one. ${TRIAL_NOTICE}${strained}`;
});
const retryTrial = async (): Promise<void> => {
    if (!reachable.value) {
        return;
    }
    await loadTrialStatus();
    await conversation.value.resume();
};

// This conversation's account when its stored credential can no longer be refreshed: surfaced as a pre-send
// banner so the user reconnects before hitting an opaque failure mid-turn (Codex today).
const activeAccountReauth = computed(() => {
    const id = account.value ?? accounts.value[0]?.id;
    return accounts.value.find((entry) => entry.id === id && entry.needsReauth === true);
});
</script>

<template>
    <!-- This conversation's agent is off the board. Muted, not a warning: archiving loses nothing (the branch,
         the diff, the transcript and every counter stay: this tab is the proof), so the line states a fact
         rather than raising an alarm. It carries the one thing no other surface could tell the user in time:
         that sending from here un-archives the agent, and the press that does it deliberately, without sending
         anything. -->
    <div v-if="activeArchived !== undefined" class="flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2 text-2xs text-muted">
        <Icon name="box" class="shrink-0" />
        <span class="min-w-0 flex-1">Archived: off the board. Sending a message restores it.</span>
        <Button
            size="small"
            :text="true"
            class="shrink-0"
            :disabled="!reachable || busyIds.includes(activeArchived.id)"
            v-tooltip.top="'Put this agent back on the board now'"
            @click="restore([activeArchived.id])"
        >
            Restore
        </Button>
    </div>
    <ChatAccountPanel />
    <!-- THE TRIAL'S STANDING DISCLOSURE. The picker says it once, at the moment of choosing; this says it for as
         long as the choice is in force, because the person typing may not be the person who picked, and a
         conversation can outlive the click that started it. Exhausted, the same strip becomes the signpost to
         the free Google sign-in: the next rung, and the one with no daily cap.

         Spent, it is also the ONLY thing on screen: the composer is behind `connected` and a used-up trial
         cannot send, so the row centres on its button rather than hanging everything off the first text line. -->
    <div
        v-if="trialNotice"
        class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-card px-3 py-2 text-left text-2xs text-muted"
    >
        <Icon name="sparkles" class="shrink-0 text-link" />
        <!-- A FLOOR, not `min-w-0`, the lesson ChatContinueStrip's own row records: every control beside this
             is `shrink-0`, so a sentence that may shrink to nothing means the line always "fits", `flex-wrap`
             never engages, and flexbox takes the whole overflow out of the TEXT instead: one word per line
             beside a row of buttons it cannot squeeze. Given a floor it wraps, and the actions drop to their
             own row, which is what wrapping is for. -->
        <span class="min-w-[14rem] flex-1">{{ trialNotice }}</span>
        <!-- THE ACTIONS, ONE BOX, ONE BASELINE. They were siblings of the sentence: a PrimeVue button next to
             a hand-rolled link chip, so the row carried two font sizes, two paddings and three baselines, and
             `items-start` hung each of them from wherever its own box happened to begin. Nothing about them
             lined up. One kit control each and one box to hold them fixes the alignment at the source rather
             than by nudging margins, and it is also what keeps them together when the row wraps. -->
        <div class="flex shrink-0 items-center gap-1">
            <Button
                v-if="trialUnavailable"
                size="small"
                severity="secondary"
                :text="true"
                :disabled="!reachable || streaming"
                v-tooltip.top="'Ask the platform again, and pick this chat back up if the trial answers'"
                @click="retryTrial"
            >
                Retry
            </Button>
            <!-- The door the account gate used to hold, here for as long as this strip is standing in its
                 place: spent, the list is where every other way to send is, and it costs nothing to look at. -->
            <ChatChooseModelButton v-if="trialSpent" />
            <!-- A place, so a link, drawn as a button: the sign-in has an address, and Ctrl/⌘-click starts it
                 in another tab rather than taking away the conversation this strip is sitting above. `as`
                 keeps the anchor and the address while the kit owns every pixel, which is the whole reason
                 this row lines up now. -->
            <Button
                :as="RouterLink"
                :to="{ path: '/sandbox/agent', query: { connect: 'gemini' } }"
                size="small"
                :text="true"
                v-tooltip.top="'Sign in with Google: no daily cap, still no subscription'"
            >
                Connect Google
            </Button>
        </div>
    </div>
    <!-- Proactive re-auth prompt: the account is connected (a credential exists) but can no longer be refreshed,
         so surface it here (before a send fails opaquely) with a jump to reconnect. -->
    <RouterLink
        v-if="activeAccountReauth"
        :to="{ path: '/sandbox/agent', query: { connect: provider } }"
        class="flex items-start gap-2 rounded-xl border border-warning/40 bg-card px-3 py-2 text-left text-2xs text-warning"
    >
        <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
        <span
            >{{ activeAccountReauth.detail ?? `This account needs to be reconnected.` }} <span class="font-semibold underline">Reconnect</span></span
        >
    </RouterLink>
</template>
