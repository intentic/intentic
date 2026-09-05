<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { formatElapsed } from "../composables/agents/agentStatus";
import { useAgents } from "../composables/agents/useAgents";
import { usePaneView } from "../composables/chat/useChat";

/* THE LIVE TURN'S ONE STATUS LINE: a spinner, what the turn is doing, and how long it has been doing it.
 *
 * IT IS THE TURN'S, NOT A MESSAGE'S, and that distinction is the whole reason this is a component rather than
 * a block inside ChatMessageView. It lived there, rendered only for the assistant bubble the turn was writing
 * into, which meant it could not exist before the provider's first frame — and a bubble is opened by the first
 * `delta`/`thinking`/`tool_call` (sandbox-contract's transcript-fold), never by the send. So the whole window
 * between "the user pressed send" and "the model said something" drew nothing at all: no spinner, no word, no
 * elapsed. On a conversation's FIRST turn that window is the entire visible state of the chat, and a routed
 * provider can hold it for a minute (a worktree to cut, a harness to spawn, a proxy to answer), during which
 * the only evidence a turn exists is the Send button having become Stop.
 *
 * The `provider_retry` line below is the sharper half of the same bug. It exists precisely to make a long
 * silence legible — the harness rides out a failing endpoint for eight attempts, roughly two minutes
 * (sdk-stream.ts), and says so on every one — and while it rendered off the assistant bubble it was structurally
 * unable to appear for the one case it was written for: a turn refused before it ever produced a first frame.
 *
 * So the line hangs off the CONVERSATION (its start instant, its retry fact, its children) and both surfaces
 * mount this one copy: ChatMessageView under the bubble a live turn is writing into, ChatPane at the foot of
 * the column when the turn has opened no bubble yet. Exactly one of those conditions holds at a time, which is
 * what keeps a single spinner on screen (see ChatPane's `liveBubble`). */

const { conversation, streaming } = usePaneView();
const { agentById } = useAgents();

// Whimsical status words cycled while a turn is streaming (Claude Code style).
const LOADER_WORDS = [
    `Thinking`,
    `Pondering`,
    `Perusing`,
    `Conjuring`,
    `Noodling`,
    `Musing`,
    `Cogitating`,
    `Ruminating`,
    `Percolating`,
    `Brewing`,
    `Tinkering`,
    `Scheming`,
    `Untangling`,
    `Synthesizing`,
];

// The second-ticking clock behind the elapsed readout and the retry countdown, armed only while a turn is
// live. This component is mounted only during one, so the guard is belt and braces: a frozen "0s" beside a
// spinner reads as a hang, and a clock left running behind a settled turn is a wake-up per second for nothing.
const now = useNow(() => streaming.value);

// The conversation owns the start instant: send() records it when the command leaves, and a later attach
// restores the daemon's. Deriving from that source means a view mounted halfway through a turn starts halfway
// through its counter too.
const loaderSeconds = computed(() => {
    const startedAt = conversation.value.turnStartedAt.value;
    return startedAt === undefined ? 0 : Math.max(0, Math.floor((now.value - startedAt) / 1000));
});
// The readout itself is the shared elapsed format, so a turn that runs long reads "9m 12s" rather than "552s".
const loaderElapsed = computed(() => {
    const startedAt = conversation.value.turnStartedAt.value;
    return startedAt === undefined ? undefined : formatElapsed(startedAt, now.value);
});
/* WHAT THE LOADER SAYS WHILE THE TURN IS ONLY WAITING ON ITS CHILDREN, which is the one stretch the whimsical
 * words are wrong about. A turn that delegated has written its "I'll come back with their results" and gone
 * quiet: nothing of its own is running, the transcript looks finished, and the only thing between it and the
 * end is agents working somewhere else. "Percolating… (6m 12s)" over that reads as a model that has hung.
 *
 * The count is the roster's: the same number the board's card and the chat rail already say, so the three
 * never disagree about how many are out (agentStatus.ts's rule). */
const liveSubagents = computed(() => agentById(conversation.value.conversationId)?.subagents?.running ?? 0);
const loaderWord = computed(() =>
    liveSubagents.value > 0
        ? `Waiting on ${liveSubagents.value} subagent${liveSubagents.value === 1 ? `` : `s`}`
        : (LOADER_WORDS[Math.floor(loaderSeconds.value / 2) % LOADER_WORDS.length] ?? `Thinking`),
);

/* THE PROVIDER IS FAILING AND THIS TURN IS RIDING IT OUT (the provider_retry frame). It takes the line over,
 * because it answers the one question the cycling word cannot: the agent is not stuck, it is waiting, and here
 * is when it tries again.
 *
 * This line is what makes the long in-turn retry budget safe to have. Without it a turn absorbing an outage looks
 * identical to a hung one for minutes at a stretch, and the move a user makes against an apparent hang is Stop:
 * the only move that actually throws away the work the turn has already done. Rides the same one-second tick as
 * the elapsed counter, so the countdown moves and stale-looks impossible. */
const providerRetry = computed(() => conversation.value.providerRetry.value);
// "and here is when it tries again" holds only when the harness said when: Claude's does. Codex reports which
// attempt it is on and nothing else (codex-agent.ts), so its line drops the countdown rather than name an
// instant the retry never agreed to.
const retryWait = computed(() => {
    const nextAttemptAt = providerRetry.value?.nextAttemptAt;
    return nextAttemptAt === undefined ? `retrying` : `retrying in ${Math.max(0, Math.round((nextAttemptAt - now.value) / 1000))}s`;
});
/* 529 is capacity, 429 is the allowance, everything else in this frame is a fault. All three are worth telling
 * apart because each points somewhere different: "at capacity" says the request was fine and a smaller model
 * would probably go through right now, "rate-limiting" says the account has been asked for too much and only
 * time or another account fixes it, and "not responding" says nobody's request is getting through. Told none of
 * that, a user watching a long wait goes looking for a fault in their own work. */
const retryReason = computed(() =>
    providerRetry.value?.status === 529 ? `at capacity` : providerRetry.value?.status === 429 ? `rate-limiting` : `not responding`,
);
</script>

<template>
    <!-- A status line, not a message: it sits at the meta tier with the tool cards it trails, and takes the
         assistant bubble's padding so the stack keeps one left edge. -->
    <div class="flex items-center gap-2 self-start rounded-lg bg-overlay px-3 py-2 text-2xs text-muted">
        <Icon name="spinner" class="text-2xs text-link" spin />
        <span v-if="providerRetry"
            >The model provider is {{ retryReason }}: {{ retryWait }}
            <span class="text-subtle">(attempt {{ providerRetry.attempt }}, nothing lost)</span></span
        >
        <span v-else
            >{{ loaderWord }}… <span v-if="loaderElapsed" class="text-subtle">({{ loaderElapsed }})</span></span
        >
    </div>
</template>
