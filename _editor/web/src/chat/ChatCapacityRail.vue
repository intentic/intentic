<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import { CAPACITY_RAIL_PX, type CapacityProvider, type CapacityRow, chatCapacity } from "../composables/chat/chatCapacity";
import { accountsLoaded } from "../composables/chat/providerAccounts";
import { formatAge, formatReset, formatUtilization, usageTone } from "../composables/chat/usageStatus";
import { refreshConnections } from "../composables/chat/useChat";
import { uiLength } from "../composables/uiScale";
import ProviderLogo from "./ProviderLogo.vue";

/* WHAT YOU CAN RUN THE NEXT TASK ON, down the right edge of the chat's own window.
 *
 * THE PROBLEM IT SOLVES. Headroom was knowable in exactly two places, and both of them cost the reader their
 * place: the model picker's footer (open a popover over the composer, one provider at a time) and the Usage tab
 * (leave the chat entirely). So the ordinary way to find out whether a plan had room left was to send a turn
 * and see whether it came back refused — the one method that spends the allowance it is asking about. A
 * popped-out chat makes that worse, not better: it is a window with no shell around it, so the Usage tab is not
 * one click away, it is another window.
 *
 * WHY IT LIVES IN SPARE WIDTH. That window is wide — it opens at 1024 and readers pull it across a monitor —
 * and the transcript inside it stops widening at its reading measure (chat.css's `.chat-turns`), so past a
 * point every extra pixel is centring. That surplus is what this occupies, and `railFitsBeside` is the whole of
 * the rule: no pane ever pays a pixel for it, and dragging the window narrower is how it goes away. It is a
 * READOUT, not a control — the one thing that can be pressed is the age of the readings, which re-measures them
 * — because the decision it informs is made in the composer, and a second place to pick an account would be a
 * second answer to a question that already has one.
 *
 * WHAT IT DOES NOT DO. It does not average, rank models, or estimate what a task will cost, and it does not
 * carry a link to the ledger it is a summary of. The exhaustive version is the Usage tab's, in the app's own
 * window — and reaching it from a pop-out means SUMMONING that window, which is a larger thing to do than a
 * glance surface should offer on a stray press. It says which subscriptions have room and how much, in the
 * order you would reach for them. The projection and its rules are in composables/chat/chatCapacity.ts. */

/* Ask for fresh readings on arrival rather than drawing whatever the tab loaded with. A plan's pools are
 * ACCOUNT-wide — the desktop app, another Claude Code and claude.ai itself spend the same allowance — so a
 * percentage is only ever as true as it is recent, and a window left open all afternoon has an afternoon-old
 * one. The connection read is what refreshes them, so mounting is exactly the moment to ask; from then on every
 * turn that ends in this window pushes its own account's reading into the same store, which is what keeps the
 * bars moving while the reader works. */
onMounted(() => void refreshConnections());

const capacity = computed(() => chatCapacity());

/* WHAT A ROW IS CALLED, and the two cases where the answer is not a name. A routed pool has no name worth
 * printing (see chatCapacity's rule 3: the address is not a choice), so the row says which of the pool's
 * readings it is showing; a lone account is already named by the heading over it, so its line is spent on the
 * pool the figure came from, which is the next thing worth knowing.
 *
 * "MOST ROOM" ONLY WHERE ROOM WAS MEASURED. It names a comparison, and a pool whose plan publishes no limits
 * has had none made: two Grok connections drew "most room" directly above "no published limits", which is one
 * line contradicting the next and both of them describing a reading that does not exist. With no figure the
 * pool falls back to the same line a lone unread account gets, and says the one true thing once. */
const rowName = (row: CapacityRow, entry: CapacityProvider): string =>
    row.label ?? (entry.pooled && row.percent !== undefined ? `most room` : row.note);

/* The whole row as one sentence: the hover for a line that had to truncate, and the only form a screen reader
 * gets. Every part the column drops is in here — the sign-in behind an ambiguous name, which pool the figure
 * came from, when it reopens.
 *
 * The PROVIDER is not, in either medium. The heading says it, the heading is directly above, and a tooltip
 * floats an inch from the name it would be repeating; spoken, it turned a three-row block into "Claude Code"
 * three times over. */
const rowDetail = (row: CapacityRow, entry: CapacityProvider): string =>
    [
        row.label,
        row.identity,
        // The same rule as the drawn line above, and it has to be stated twice because the two mediums are
        // built separately: a comparison nothing was measured for must not be claimed in either.
        entry.pooled && row.percent !== undefined ? `most room of ${entry.ready}` : undefined,
        row.percent === undefined ? row.note : `${row.note} ${formatUtilization(row.percent, row.stale)}`,
        row.resetsAt === undefined ? undefined : `resets ${formatReset(row.resetsAt)}`,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);

// What holds a provider back, and when waiting fixes it. Both, because neither is the answer on its own: a bare
// "Mon 22:32" beside a provider's name says nothing about what happens then, and a bare "spent" leaves the one
// question a spent plan raises unanswered.
const outNote = (entry: { readonly reason: string; readonly reopensAt: number | undefined }): string =>
    entry.reopensAt === undefined ? entry.reason : `${entry.reason} · ${formatReset(entry.reopensAt)}`;

const countDetail = (entry: CapacityProvider): string =>
    `${entry.ready} of ${entry.total} accounts have room${entry.pooled ? `, and turns are spread across them automatically` : ``}`;

/* HOW OLD THESE NUMBERS ARE, and the button that makes them new — one control, because a re-measure with
 * nothing to compare against has an invisible effect, and an age with no way to act on it is a complaint. The
 * age is the label: pressing it and watching "14m ago" become "just now" is the whole confirmation, and it
 * staying put is the other answer and an honest one. Forced, because the daemon holds a reading for a minute
 * before it will go back upstream, and the person pressing this is asking about the minute they are in. */
const measuring = ref(false);
const remeasure = async (): Promise<void> => {
    measuring.value = true;
    try {
        await refreshConnections(true);
    } finally {
        measuring.value = false;
    }
};
const remeasureLabel = computed(() =>
    capacity.value.measuredAt === undefined ? `Measure plan limits` : `Re-measure plan limits, measured ${formatAge(capacity.value.measuredAt)}`,
);
</script>

<template>
    <!-- Drawn only once there is something to say. A sandbox with no AI account connected gets no rail at all:
         an empty column standing beside the transcript would be 240px spent teaching the reader that this
         surface has nothing for them, every time they open a window. -->
    <!-- NO SURFACE OF ITS OWN: no card fill, no rule down its left. This is a readout standing in the window's
         empty margin, not a panel competing with the transcript, and a border plus a fill would draw a second
         frame around something that is already separated from the panes by a column of air. What tells the
         reader it is a distinct region is the whitespace and the heading, which is all it needs to be. -->
    <aside
        v-if="!accountsLoaded || capacity.accounts > 0"
        class="flex h-full min-h-0 shrink-0 flex-col"
        :style="{ width: uiLength(CAPACITY_RAIL_PX) }"
        aria-label="Plan headroom"
    >
        <!-- The header names the question the column answers, not the data it holds ("Plan limits" is the Usage
             tab's heading, and it is a heading for a ledger). Beside it, the age of everything below. -->
        <div class="flex shrink-0 items-center gap-2 px-3 py-2">
            <span class="min-w-0 flex-1 truncate text-2xs font-medium uppercase tracking-wide text-muted">Ready to run</span>
            <button
                type="button"
                :class="ui.textAction(`gap-1 text-2xs text-subtle`)"
                :disabled="measuring"
                v-tooltip.left="`Re-measure every account's plan limits now`"
                :aria-label="remeasureLabel"
                @click="remeasure"
            >
                <Icon name="refresh" class="text-[0.6rem]" :spin="measuring" />
                <span v-if="capacity.measuredAt !== undefined">{{ formatAge(capacity.measuredAt) }}</span>
            </button>
        </div>

        <!-- An unread state is not an empty one: until the connection read lands this must not claim the fleet
             has nothing. It is drawn as the shape that is coming rather than said in words — a sentence where a
             list goes is a claim the panel then takes back. -->
        <div v-if="!accountsLoaded" class="flex min-h-0 flex-1 flex-col gap-4 px-3 py-1" role="status" aria-busy="true">
            <span class="sr-only">Reading your connections…</span>
            <div v-for="index in 3" :key="index" class="flex flex-col gap-1.5" aria-hidden="true">
                <span class="skeleton block h-2.5 w-24" />
                <span class="skeleton block h-1 w-full rounded-full" />
            </div>
        </div>

        <template v-else>
            <div class="scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-3">
                <!-- Every provider spent at once is the ordinary end of a working week, not an error, so it is
                     stated plainly and the list below says when each one is back. -->
                <p v-if="capacity.providers.length === 0" class="text-2xs text-muted">Nothing has room right now.</p>

                <!-- ONE BLOCK PER PROVIDER, because the provider is the choice a reader makes here: the
                     translator balances turns across a provider's accounts, so "which of my 31 Google sign-ins"
                     is nobody's decision. The mark and the name head the block; the bars hang under it with no
                     frame of their own, since the column draws no surface at all and a card per provider would
                     be the only box on screen, saying what the gap above it already says for free. -->
                <div v-for="entry in capacity.providers" :key="entry.provider" class="flex flex-col gap-1.5">
                    <div class="flex items-center gap-1.5">
                        <ProviderLogo :provider="entry.provider" class="shrink-0 text-2xs text-muted" />
                        <span class="min-w-0 flex-1 truncate text-2xs font-medium text-content">{{ entry.label }}</span>
                        <!-- How much of this provider survives, as a count and never a mean: 30 idle accounts
                             and one spent one is not "3% used", it is one account you cannot use. Absent for a
                             lone account, where "1 of 1" is a fact nobody came here for. -->
                        <span
                            v-if="entry.total > 1"
                            class="shrink-0 text-2xs tabular-nums text-subtle"
                            v-tooltip.left="countDetail(entry)"
                            :aria-label="countDetail(entry)"
                            >{{ entry.ready }}/{{ entry.total }}</span
                        >
                    </div>

                    <!-- TWO LINES PER ACCOUNT: what it is with its figure, and the bar. The pool the figure
                         came from and the instant it reopens ride the hover instead of a third line — at this
                         width a third line per account turns three providers into a column you scroll, which
                         is the one thing a glance surface must not become. -->
                    <!-- THE DRAWN ROW IS THE DECORATION AND THE SENTENCE IS THE CONTENT, the same split
                         UsageRing draws: a bar means nothing to a screen reader and a hover never reaches one,
                         so the whole row is hidden from the tree and spoken once, in full, below. Announcing
                         both would read the truncated half and then the complete one. -->
                    <div v-for="row in entry.rows" :key="row.id" class="flex flex-col gap-1" v-tooltip.left="rowDetail(row, entry)">
                        <div class="flex items-baseline justify-between gap-2" aria-hidden="true">
                            <span class="min-w-0 truncate text-2xs" :class="row.label === undefined ? `text-subtle` : `text-muted`">
                                {{ rowName(row, entry) }}
                            </span>
                            <span v-if="row.percent !== undefined" class="shrink-0 text-2xs font-medium tabular-nums" :class="usageTone(row.percent)">
                                {{ formatUtilization(row.percent, row.stale) }}
                            </span>
                        </div>
                        <!-- A pool at 0% still draws a sliver: an empty track reads as "no reading", and those
                             mean opposite things. Which is why a row that genuinely has no reading draws no
                             track at all and says so in words instead. -->
                        <div v-if="row.percent !== undefined" class="h-1 overflow-hidden rounded-full bg-content/10" aria-hidden="true">
                            <div
                                class="h-full rounded-full bg-current"
                                :class="usageTone(row.percent)"
                                :style="{ width: `${Math.max(row.percent, 1)}%` }"
                            />
                        </div>
                        <!-- …and only when the line above is not already saying it, which it is for a row that
                             has no name of its own to print (an unread lone account reads "no reading yet"
                             once, not twice). -->
                        <span v-else-if="rowName(row, entry) !== row.note" class="text-2xs text-subtle" aria-hidden="true">{{ row.note }}</span>
                        <span class="sr-only">{{ rowDetail(row, entry) }}</span>
                    </div>

                    <!-- Never a silent cap: a provider showing three of five says which three these were. -->
                    <span v-if="entry.hidden > 0" class="text-2xs text-subtle">+{{ entry.hidden }} more with room</span>
                </div>

                <!-- WHAT IS NOT ON THE LIST, AND WHY. Without this the absence of a provider means two opposite
                     things — spent until Sunday, or never connected — and the reader has no way to tell them
                     apart short of leaving the window. Each line carries the one fact that decides what to do
                     about it: an instant to wait for, or a condition that needs a person.

                     IN FLOW, UNDER THE OFFERS, not pinned to the bottom edge. Pinned, a short list left a hand's
                     width of nothing between what the reader can run and what they cannot, and a gap that size
                     reads as the end of the column rather than as a break in it. Reference belongs after the
                     thing it qualifies, and scrolling out of sight when the offers are many is the correct
                     priority: this rail is opened to find what IS available. -->
                <div v-if="capacity.out.length > 0 || capacity.needsReauth > 0" class="flex flex-col gap-1 border-t border-line pt-3">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Unavailable</span>
                    <div v-for="entry in capacity.out" :key="entry.provider" class="flex items-baseline gap-2" v-tooltip.left="entry.detail">
                        <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ entry.label }}</span>
                        <span class="shrink-0 text-2xs text-subtle">{{ outNote(entry) }}</span>
                    </div>
                    <!-- Counted rather than listed, and pointed at the one place that can fix it. A dead
                         credential is the only state here that stays broken until a person acts, so it earns its
                         own line however many accounts are in it. -->
                    <!-- The condition is the alarm; the instruction is not. Tone is a ranking, and running it
                         through the fix as well makes the sentence shout twice — the same split the Usage tab's
                         attention block draws, where the state is coloured and "reconnect them on the Agent
                         tab" is quiet beside it. -->
                    <p v-if="capacity.needsReauth > 0" class="text-2xs">
                        <span class="text-warning">{{ capacity.needsReauth }} sign-in{{ capacity.needsReauth === 1 ? `` : `s` }} expired</span>
                        <span class="text-subtle"> · reconnect on the Agent tab</span>
                    </p>
                </div>
            </div>
        </template>
    </aside>
</template>
