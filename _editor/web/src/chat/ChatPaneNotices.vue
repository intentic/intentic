<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { isTrialProvider, TRIAL_NOTICE } from "@intentic/sandbox-contract";
import { trialExhausted } from "../composables/chat/access";
import { useAgents } from "../composables/agents/useAgents";
import { trialStatus } from "../composables/chat/providerCatalog";
import { formatWait } from "../composables/chat/usageStatus";
import { loadTrialStatus, usePaneView } from "../composables/chat/useChat";
import { useSandbox } from "../composables/sandbox/useSandbox";
import ChatAccountPanel from "./ChatAccountPanel.vue";

/* WHAT THIS CHAT'S STANDING IS, said above the composer: the strips that report a state the conversation
 * arrived at by itself, each with the one press that answers it.
 *
 * They are together because they are the same kind of thing and share one slot's worth of the reader's
 * attention, in this order: what this agent IS (archived), what it can send with (the account gate, the trial,
 * an expired credential), and what happened to the last turn (an outage). What the composer is FOR: a
 * continuation waiting on a press, an armed edit, stays with the composer: those describe the box, not the
 * chat.
 *
 * Everything here reads this pane's own conversation through the injected view, never the focused one: with two
 * chats side by side, a banner about the wrong one is worse than no banner. */

const { conversation, provider, account, accounts, streaming } = usePaneView();
const { reachable } = useSandbox();
const { agentById, archived, loadArchived, restore, busyIds, setResumeAfterOutage } = useAgents();

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
const trialHealthIssue = computed(() => trialStatus.value.health === `degraded` || trialStatus.value.health === `unavailable`);
const trialNotice = computed(() => {
    if (!isTrialProvider(provider.value)) {
        return undefined;
    }
    if (trialExhausted(provider.value)) {
        return `Free trial used up for today. Connect a Google account to keep going free: no subscription, no daily cap.`;
    }
    if (trialStatus.value.health === `unavailable`) {
        return `Free trial temporarily unavailable: failed messages aren't counted.`;
    }
    if (trialStatus.value.health === `degraded`) {
        return `Free trial service is degraded: another upstream key may still answer, and failed messages aren't counted.`;
    }
    const remaining = trialStatus.value.remaining;
    const left = `${remaining} free ${remaining === 1 ? `message` : `messages`} left today`;
    /* WHICH MODEL ANSWERED, once one has. The trial publishes a single row and picks a real model per message
     * (the platform's trial-ladder.ts), so without this the user cannot tell a weak answer from a fallback rung
     *, and neither can we, reading their bug report. It leads the sentence only after a turn has run: before
     * that there is nothing true to say, and a placeholder would be a promise about a choice not yet made. */
    const served = trialStatus.value.servedModel;
    const answered = served === undefined ? `` : `Last answer: ${served}. `;
    return `${answered}${left}: a step of an agent's turn spends one. ${TRIAL_NOTICE}`;
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

/* The outage banner (Conversation.failures.outageResume). A spent usage limit gets no equivalent: it has a known
 * reset instant and nothing anyone can do before it, so the transcript notice naming that instant says
 * everything there is to say. An outage has no known end, which is why it needs a live banner: its whole job is
 * to answer "is anything still happening?", which during an outage is the only question anyone has. When the
 * resume is off it is instead the offer to arm it, which arms the very turn that bounced (the daemon remembered
 * it either way).
 *
 * THE PRESS ARMS THIS CHAT AND NOTHING ELSE. It used to write the sandbox-wide setting, and the gap between what
 * the button looked like: one line in one conversation, under one dead turn, and what it did was the whole
 * bug: a person finishing one piece of work at midnight silently signed every agent on the board up to re-run
 * its turns on their allowance. So it writes this conversation's own override (agents.resumeAfterOutage) and the
 * sandbox default stays where a standing policy belongs, in Sandbox ▸ Agent.
 *
 * …and the same press pointing the other way. `false`, not null: somebody stopping a retry they can watch
 * counting down means THIS chat, now: handing it back to a default that may well say "resume" would restart the
 * very thing they just stopped. The daemon keeps the stranded turn either way; it simply stops offering it to
 * the breaker, and the hour-long staleness sweep retires it. */
const outageResume = computed(() => conversation.value.failures.outageResume.value);
const arming = ref(false);
const setOutageResume = async (resume: boolean): Promise<void> => {
    if (!reachable.value || arming.value) {
        return;
    }
    arming.value = true;
    try {
        await setResumeAfterOutage(conversation.value.conversationId, resume);
        if (resume) {
            conversation.value.failures.armOutageResume();
            return;
        }
        conversation.value.failures.disarmOutageResume();
    } catch {
        // Left as it stands, in both directions: the offer stays up to press again and the countdown stays
        // honest until the daemon has actually been told otherwise. A banner that vanished on a failed write
        // would claim a resume nobody armed.
    } finally {
        arming.value = false;
    }
};
</script>

<template>
    <!-- This conversation's agent is off the board. Muted, not a warning: archiving loses nothing (the branch,
         the diff, the transcript and every counter stay: this tab is the proof), so the line states a fact
         rather than raising an alarm. It carries the one thing no other surface could tell the user in time:
         that sending from here un-archives the agent, and the press that does it deliberately, without sending
         anything. -->
    <div
        v-if="activeArchived !== undefined"
        class="flex items-center gap-2 rounded-xl border border-line bg-overlay/60 px-3 py-2 text-2xs text-muted"
    >
        <Icon name="box" class="shrink-0" />
        <span class="min-w-0 flex-1">Archived: off the agents board. Sending a message puts it back.</span>
        <button
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15 disabled:opacity-50"
            :disabled="!reachable || busyIds.includes(activeArchived.id)"
            v-tooltip.top="'Put this agent back on the board now'"
            @click="restore([activeArchived.id])"
        >
            Restore
        </button>
    </div>
    <ChatAccountPanel />
    <!-- THE TRIAL'S STANDING DISCLOSURE. The picker says it once, at the moment of choosing; this says it for as
         long as the choice is in force, because the person typing may not be the person who picked, and a
         conversation can outlive the click that started it. Exhausted, the same strip becomes the signpost to
         the free Google sign-in: the next rung, and the one with no daily cap. -->
    <div
        v-if="trialNotice"
        class="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-xl border border-line bg-overlay/40 px-3 py-2 text-left text-2xs text-muted"
    >
        <Icon name="sparkles" class="mt-0.5 shrink-0 text-link" />
        <span class="min-w-0 flex-1">{{ trialNotice }}</span>
        <button
            v-if="trialHealthIssue"
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15 disabled:opacity-50"
            :disabled="!reachable || streaming"
            @click="retryTrial"
        >
            Retry
        </button>
        <!-- A place, so a link: the sign-in has an address, and Ctrl/⌘-click starts it in another tab rather
             than taking away the conversation this strip is sitting above. -->
        <RouterLink
            :to="{ path: '/sandbox/agent', query: { connect: 'gemini' } }"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15"
        >
            Connect Google
        </RouterLink>
    </div>
    <!-- Proactive re-auth prompt: the account is connected (a credential exists) but can no longer be refreshed,
         so surface it here (before a send fails opaquely) with a jump to reconnect. -->
    <RouterLink
        v-if="activeAccountReauth"
        :to="{ path: '/sandbox/agent', query: { connect: provider } }"
        class="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-left text-2xs text-warning"
    >
        <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />
        <span
            >{{ activeAccountReauth.detail ?? `This account needs to be reconnected.` }} <span class="font-semibold underline">Reconnect</span></span
        >
    </RouterLink>
    <!-- Provider-outage banner: the turn is coming back on an escalating backoff, and this says when and how
         many tries are left. Naming the bound is the point: an automation spending the user's allowance while
         they watch has to account for itself, or the reasonable response is to switch it back off. -->
    <div
        v-if="outageResume"
        class="flex flex-wrap items-start gap-x-2 gap-y-1 rounded-xl border border-line-strong bg-overlay/60 px-3 py-2 text-2xs text-muted"
    >
        <Icon name="clock" class="mt-0.5 shrink-0" />
        <span v-if="outageResume.scheduled" class="min-w-0 flex-1"
            >This chat is picking the turn back up by itself in {{ formatWait(outageResume.retryAt) }}: attempt {{ outageResume.attempt }} of
            {{ outageResume.maxAttempts }} since the provider failed it. Sending again yourself works too.</span
        >
        <!-- THE WAY BACK OUT, in the surface that armed it. Symmetry is the point: a press that starts something
             automatic and can only be undone from a settings page is how people learn not to press it. The
             button that turns this on is two lines down, and this is the same button pointing the other way. -->
        <button
            v-if="outageResume.scheduled"
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15 disabled:opacity-50"
            :disabled="!reachable || arming"
            @click="setOutageResume(false)"
        >
            Stop
        </button>
        <!-- The button arms THIS CHAT and nothing else, which is the one thing about it worth saying, so the
             sentence says it, in the words the press is made of ("this chat", "keep going") rather than in the
             name of a setting. The old copy admitted the sandbox-wide blast radius in a parenthesis, which is
             exactly the place nobody reads before pressing; the honest fix was to make the press smaller, not
             the warning louder. Where the standing default lives is a different question, and it is answered on
             the notice the press writes. -->
        <span v-else class="min-w-0 flex-1"
            >The model provider failed this turn and nothing is retrying it. Keep this chat going and it picks the turn back up by itself as soon as
            the provider answers.</span
        >
        <button
            v-if="!outageResume.scheduled"
            type="button"
            class="shrink-0 rounded-full px-2 py-px font-semibold text-link transition-colors hover:bg-primary-600/15 disabled:opacity-50"
            :disabled="!reachable || arming"
            @click="setOutageResume(true)"
        >
            Keep this chat going
        </button>
    </div>
</template>
