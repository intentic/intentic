<script setup lang="ts">
import { computed, ref } from "vue";
import { type AgentHarness, type KeyedProvider, limitationsOf } from "@intentic/sandbox-contract";
import UsageRing from "../components/UsageRing.vue";
import { relativeTime } from "../composables/chat/catalog";
import type { Conversation } from "../composables/chat/conversation";
import { providerDisplayLabel } from "../composables/chat/providerCatalog";
import type { PickerEntry } from "../composables/chat/modelPicker";
import { providerRefusals, translatorAccounts } from "../composables/chat/providerAccounts";
import { formatAge, liveUsage, planHeadroom, refusalNote, usagePercent } from "../composables/chat/usageStatus";
import { accountsOf, refreshConnections, subscriptionOnly } from "../composables/chat/useChat";
import ModelPicker from "./ModelPicker.vue";
import ProviderLogo from "./ProviderLogo.vue";

/* THE CHAT'S BINDING OF THE APP'S MODEL PICKER — the shared list (ModelPicker) plus the footer of controls that
 * only mean something when there IS a conversation: which connected account serves the next turn, the harness
 * axis, Claude's extended-thinking knob, fast speed, and what this runtime cannot do.
 *
 * IT EDITS THE CONVERSATION IT IS GIVEN, not "the active tab". The composer hands it the active one; the
 * suggested-session dialog hands it a DRAFT that has no tab yet (SuggestedSessionBox.vue), so that a session
 * being proposed can be re-pointed at a different model before it is ever started. Binding to the active tab
 * instead would have made the dialog's picker silently edit whatever chat happened to be open behind it.
 *
 * The harness (the provider's own / Claude Code) is a separate axis from the model, chosen via the footer chips
 * — codex/grok run the same subscription model ids under either harness. A mid-chat cross-provider pick just
 * re-points the selection — the fresh session starts lazily at the next send. */

const emit = defineEmits<{ selected: [] }>();
const { conversation } = defineProps<{ conversation: Conversation }>();

/* Destructured ONCE, which is sound only because every host remounts this body per open — AnchoredOverlay
 * teleports behind a `v-if="open"` and BottomSheet does the same, in both ChatPanel and SuggestedSessionBox.
 * These are the refs of the conversation as it was at mount, so a host that swapped the prop in place would go
 * on editing the previous one. Remount, don't rebind. */
const { provider, harness, model, thinking, fast, fastOffered, fastMode, streaming, account, capabilities } = conversation;
// The active provider's connected accounts. Module state rather than the conversation's, because an account
// list belongs to the sandbox — the conversation only picks WHICH of them its next turn runs on.
const accounts = computed(() => accountsOf(provider.value));

// Mid-stream, only a same-provider model swap is allowed (a provider switch retires the session).
const unpickable = (entry: PickerEntry): boolean => streaming.value && entry.provider !== provider.value;

const pick = (entry: PickerEntry): void => {
    conversation.selectModel(entry);
    emit(`selected`);
};

// The harness axis, shown as footer chips for codex/grok (claude is always its own loop). Both chips NAME the
// runtime they select — the native one is labelled for the provider whose loop it actually is ("ChatGPT", "Grok"),
// never "Default", which would say nothing about what runs while sitting opposite a chip that does.
const harnessOptions = computed<readonly { label: string; value: AgentHarness }[]>(() => [
    { label: providerDisplayLabel(provider.value), value: `native` },
    { label: `Claude Code`, value: `claude-code` },
]);
const harnessChoosable = computed(() => provider.value === `codex` || provider.value === `grok`);

// The account the turn will use: the explicit pick, else the first (the daemon's default) — so the picker
// always highlights the one in effect, even before the user touches it.
const activeAccountId = computed(() => account.value ?? accounts.value[0]?.id);

/* What the selected provider/harness pair does NOT do, straight off its declared record. The picker is where
 * the choice is made, so it is where the trade-off belongs: picking Grok gives up mid-turn steering and per-tool
 * approvals, and nothing else in the app was ever going to say so — the controls simply stopped working. An
 * empty list (the Claude Code loop, which is the ceiling) renders nothing at all. */
const limitations = computed(() => limitationsOf(capabilities.value));

/* WHY THE FAST TOGGLE DIDN'T DO WHAT IT SAYS — the sentence for each reason the harness can give (its own
 * FastModeDisabledReason vocabulary, forwarded verbatim on the `fast_mode` frame).
 *
 * Every one of these is a state the user can be in with the control switched on and nothing visibly different
 * about the turn except the speed, so each needs to say what happened AND whether they can do anything about
 * it. An unrecognized reason is not swallowed: a newer harness may report something this build hasn't heard
 * of, and the raw word beats silence — it is at least searchable. */
const FAST_MODE_REASONS: Record<string, string> = {
    free: `Fast speed needs a paid plan.`,
    preference: `Fast speed is switched off in this account's Claude settings.`,
    extra_usage_disabled: `Fast speed needs extra usage enabled on this account.`,
    model_not_allowed: `This model doesn't offer fast speed.`,
    not_first_party: `Fast speed isn't available on a routed endpoint.`,
    disabled_by_env: `Fast speed is disabled by this sandbox's environment.`,
    sdk_opt_in_required: `The harness declined the fast-speed request.`,
    network_error: `Couldn't reach Anthropic to confirm fast speed.`,
    pending: `Still confirming fast speed.`,
};

/* The one line under the toggle, and only when the answer DISAGREES with the ask. Three cases, in the order
 * they matter: cooldown (asked, had it, spent the separate fast-mode pool — it comes back by itself), refused
 * (asked, never got it — the reason says whether that is fixable), and served-anyway (didn't ask but got it,
 * which happens when the account's own Claude settings turn fast mode on, and is worth saying because it is
 * being billed). Agreement renders nothing: a notice confirming that a control did what it says is noise. */
const fastSpeedNotice = computed<string | undefined>(() => {
    const state = fastMode.value;
    if (state === undefined) {
        return undefined;
    }
    if (state.state === `cooldown`) {
        return `Fast speed is rate-limited right now — turns run at standard speed until it resets.`;
    }
    if (state.state === `on`) {
        return fast.value ? undefined : `Ran at fast speed — this account has fast mode switched on by default.`;
    }
    if (!fast.value) {
        return undefined;
    }
    return state.reason === undefined
        ? `The last turn ran at standard speed.`
        : (FAST_MODE_REASONS[state.reason] ?? `The last turn ran at standard speed (${state.reason}).`);
});

/* THE SUBSCRIPTIONS THIS CONVERSATION WOULD RUN ON INSTEAD, for the three providers that own no account and for
 * Grok under the Claude Code harness. They are not a picker: CLIProxyAPI holds every auth file and balances
 * turns across them, so there is nothing here to choose and these rows are read-only.
 *
 * They are listed anyway, because the alternative was silence. This footer showed an account list for Claude
 * and nothing whatsoever for ChatGPT, Kimi or Google — which reads as "this provider has no connections", one
 * step from "why is my ChatGPT not signed in", rather than as "they are held somewhere else and there is
 * nothing to pick". Same rings, same meaning, one line saying who chooses. */
const routedProvider = computed<KeyedProvider | undefined>(() => {
    const target = provider.value;
    if (subscriptionOnly(target)) {
        return target;
    }
    // Grok is the one provider served BOTH ways: its own account runs its own loop, and the subscription runs
    // its models under the Claude Code harness. Which of the two is on screen follows the harness chip below.
    return target === `grok` && harness.value === `claude-code` ? `grok` : undefined;
});

const routedRows = computed(() =>
    routedProvider.value === undefined
        ? []
        : translatorAccounts.value[routedProvider.value].map((entry) => ({
              name: entry.name,
              label: entry.label,
              headroom: planHeadroom(liveUsage(entry.name, entry.usage)),
          })),
);

/* WHEN THIS PROVIDER LAST REFUSED A TURN, read against everything that has happened since — the observed half
 * of "can I run on this", beside the polled half the rings draw. Judged over BOTH lists and against the whole
 * of each, exactly as the Agent tab judges it (AiAccountSection's `refusal`): whether a refusal still stands is
 * a question about the provider, so every connection it holds gets a say, and the two surfaces disagreeing
 * about the same event is the bug that made a healthy Kimi account look broken. */
const providerRefusalNote = computed(() =>
    refusalNote(providerRefusals.value[provider.value], [
        ...accounts.value.map((entry) => {
            const usage = liveUsage(entry.id, entry.usage);
            return {
                account: entry.id,
                measuredAt: usage?.measuredAt,
                percent: usagePercent(usage),
                needsReauth: entry.needsReauth === true,
            };
        }),
        ...routedRows.value.map((row) => ({
            account: row.name,
            measuredAt: row.headroom?.measuredAt,
            percent: row.headroom?.percent,
            needsReauth: false,
        })),
    ]),
);

/* THE SAME REFUSAL WHERE NO ROW CAN CARRY IT. Two cases, and between them they are most of the ones that matter:
 * a provider with a SINGLE account draws no account list at all (there is nothing to choose between), and a
 * ROUTED refusal names no account because CLIProxyAPI picked the auth file itself. Placed on the block instead,
 * which is where the Agent tab puts an unattributable one too — the alternative was the state this whole change
 * exists to end, where the only place a refusal appeared was the chat that provoked it. */
const unplacedRefusal = computed(() => {
    const note = providerRefusalNote.value;
    const refused = providerRefusals.value[provider.value]?.account;
    if (note?.current !== true) {
        return undefined;
    }
    const onARow = accounts.value.length > 1 && accounts.value.some((entry) => entry.id === refused);
    return onARow ? undefined : note.line;
});

const footerVisible = computed(
    () =>
        accounts.value.length > 1 ||
        routedRows.value.length > 0 ||
        provider.value === `claude` ||
        harnessChoosable.value ||
        limitations.value.length > 0 ||
        // A standing refusal earns the footer on its own. Every other clause here happens to be true in the
        // cases that produce one today, which is a coincidence and not a reason to let one go unsaid.
        unplacedRefusal.value !== undefined,
);

// Names shared by more than one connected account — the rows a name alone cannot tell apart.
const ambiguousLabels = computed(() => {
    const seen = new Map<string, number>();
    for (const entry of accounts.value) {
        seen.set(entry.label, (seen.get(entry.label) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
});

/* The account rows, each decorated with the two things a switch decision actually turns on.
 *
 * WHICH ONE THIS IS — the identity the provider reported (Claude returns the email + organization with the
 * token), under the name, because the name is the user's to change and two of them can read the same. Failing
 * that, and only when two rows DO read the same, the date it was connected: a weak difference, but picking
 * between two lines that both say "Claude" is not a choice, it's a coin flip. Quiet otherwise — a single
 * self-explaining account earns no second line.
 *
 * HOW MUCH IS LEFT — how much of its TIGHTEST limit pool is spent, which is the whole point of the account list
 * being a list and used to cost a turn to find out. Drawn as the same ring the connection list and the composer
 * chip use for this number, rather than as the bare percentage it was: three percentages down a column are read
 * one at a time and compared by arithmetic, where three arcs are compared at a glance — which is the only
 * question being asked here (which of these has the most room?). The exact figure, its per-pool breakdown and
 * how old the reading is stay one hover away — the card UsageRing opens BESIDE the row, so reading one
 * account's pools never covers the rows it is being compared against — and a row with no ring at all means no
 * reading, never "empty".
 *
 * WHETHER IT CAN RUN AT ALL — which the ring cannot answer and had been left to find out by trying. A poll and
 * a refusal are different kinds of fact (see providerAccounts.providerRefusals): the ring is a reading of the
 * PLAN, and an account whose organization has switched Claude Code off for it publishes full pools right up to
 * the moment it turns every turn away. So this row drew a confident green arc over the one account in the list
 * that could not serve anything, and the only way to learn that was to pick it and send. The Agent tab and the
 * Usage tab have both drawn refusals for a while; this is the surface where the account is actually CHOSEN, and
 * it was the one drawing none. */
const accountRows = computed(() => {
    const refusal = providerRefusals.value[provider.value];
    const note = providerRefusalNote.value;
    return accounts.value.map((entry) => {
        const identity = [entry.email, entry.organization].filter((part) => part !== undefined && part !== entry.label);
        return Object.assign({}, entry, {
            subtitle:
                identity.length > 0
                    ? identity.join(` · `)
                    : ambiguousLabels.value.has(entry.label)
                      ? `connected ${relativeTime(entry.connectedAt)}`
                      : undefined,
            // liveUsage, not the streamed map alone: the daemon's reading rides the row itself and is the newer
            // of the two whenever no turn has ended in this tab since — which is most of the time.
            headroom: planHeadroom(liveUsage(entry.id, entry.usage)),
            /* Only while it STANDS, and only on the account it names. A refusal something since has answered is
             * history, and history does not belong on a row someone is about to click; a refusal the daemon
             * could not attribute (a routed turn) belongs to no row here at all. Both of those are the Agent
             * tab's to report in full — this footer carries the one fact that changes the click. */
            refused: note?.current === true && refusal?.account === entry.id ? note.line : undefined,
        });
    });
});

/* ---- how old these numbers are, and the way to make them new ------------------------------------------------
 *
 * The rings are refreshed by the panel opening (ModelPicker's onMounted), which is what stopped them being as
 * old as the browser tab. This says so, and gives the reader the one move that seam cannot make for them.
 *
 * THE OLDEST READING ON SCREEN, not the newest and not the active account's: the header qualifies every ring
 * under it, and a header that reports its freshest row would vouch for a stale one sitting directly beneath.
 * Undefined when nothing has been measured at all — the control still shows, because "no reading yet" is
 * exactly a state worth retrying.
 *
 * Read once per open, like every other age in this app (formatAge, the ring's own card): the panel lives for
 * seconds, and a minute counter ticking under a list being compared is motion that buys nothing. */
const measuredAt = computed<number | undefined>(() => {
    const taken = [...accountRows.value, ...routedRows.value].flatMap((row) => (row.headroom === undefined ? [] : [row.headroom.measuredAt]));
    return taken.length === 0 ? undefined : Math.min(...taken);
});

/* RE-MEASURE, FORCED. The daemon holds a reading for a minute before it will go back upstream, which is right
 * for every automatic read and wrong for this one: the person pressing it has just changed something about the
 * account — a seat downgraded, a plan swapped, a limit spent on another machine — and is asking whether what
 * they can see survived it. Answering from the last minute would hand back the number they pressed the button
 * to doubt. Forced, it costs one free round-trip per account and the rings redraw under the cursor.
 *
 * Every connection, not this provider's: the list above this footer spans every provider and locks the ones
 * with no credential, so a read that covered only the session's own would leave the rest of the panel as stale
 * as it was. */
const measuring = ref(false);
// The age is on screen as the button's own label, so the spoken name has to carry it too — a bare
// "Re-measure plan limits" tells a screen-reader user what the control does and nothing about whether to press
// it, which is the only question the sighted version answers at a glance.
const remeasureLabel = computed(() =>
    measuredAt.value === undefined ? `Measure plan limits` : `Re-measure plan limits — measured ${formatAge(measuredAt.value)}`,
);
const remeasure = async (): Promise<void> => {
    measuring.value = true;
    try {
        await refreshConnections(true);
    } finally {
        measuring.value = false;
    }
};
</script>

<template>
    <ModelPicker :provider="provider" :model="model" :unpickable="unpickable" @pick="pick" @close="emit(`selected`)">
        <template #footer>
            <!-- Session controls that have no place in the shared list: which connected account serves the next
                 turn, the harness axis (codex/grok), Claude's extended-thinking knob, fast speed, and what this
                 runtime cannot do. Controls and the state of them — no standing prose. -->
            <!-- Padded on the model list's own 12px rhythm (ModelPicker's rows and section headers are all
                 `px-3`), because the two read as one column: at the footer's old 8px every label in it sat
                 four pixels inboard of the headings directly above, close enough to the panel edge to look
                 like a crop rather than a margin. The row groups below take that padding back with `-mx-3`
                 so their tint spans the panel exactly as a model row's does — bleed is the LIST's idiom, and
                 the text still lands on the 12px line. -->
            <div v-if="footerVisible" class="flex shrink-0 flex-col gap-2 border-t border-line px-3 py-2">
                <!-- WHOSE SETTINGS THESE ARE. The list above is a BROWSE surface — the rail filters it across
                     every provider without touching the conversation — while everything below configures the
                     conversation you are in. The two disagree whenever the rail is pointed elsewhere, and
                     unlabelled they read as one screen: a column of Claude sign-ins under a list of GPT models
                     looks like ChatGPT's account list. The provider's own mark and name, at the head of the
                     block, is what keeps the footer legible as the session it belongs to. -->
                <div class="flex items-center justify-between gap-2">
                    <span class="flex min-w-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted">
                        <ProviderLogo :provider="provider" class="shrink-0 text-xs" />
                        <span class="truncate">{{ providerDisplayLabel(provider) }} session</span>
                    </span>
                    <span class="flex shrink-0 items-center gap-2">
                        <!-- HOW OLD THESE READINGS ARE, and the button that makes them new — one control,
                             because a re-measure with nothing to compare against is a button whose effect is
                             invisible, and an age with no way to act on it is a complaint. The age is the
                             label: pressing it and watching "14m ago" become "just now" is the whole
                             confirmation. It staying put is the other answer, and an honest one — this account
                             cannot be read right now, whatever its ring still says. -->
                        <button
                            type="button"
                            class="flex items-center gap-1 text-2xs text-subtle hover:text-content"
                            :disabled="measuring"
                            v-tooltip.top="`Re-measure every account's plan limits now`"
                            :aria-label="remeasureLabel"
                            @click="remeasure"
                        >
                            <Icon name="refresh" class="text-[0.6rem]" :spin="measuring" />
                            <span v-if="measuredAt !== undefined">{{ formatAge(measuredAt) }}</span>
                        </button>
                        <!-- A ring is a glance; the Usage tab is where the windows, their reset times, and what
                             has been spent against them actually live. -->
                        <RouterLink to="/sandbox/usage#accounts" class="text-2xs text-link hover:underline" @click="emit(`selected`)"
                            >Headroom</RouterLink
                        >
                    </span>
                </div>

                <!-- The refusal that belongs to this session but to no row in it (see unplacedRefusal). Directly
                     under the header, above every control it qualifies: it is the reason the numbers below may
                     be beside the point, so a reader who stops here has still been told. -->
                <p v-if="unplacedRefusal" class="flex items-start gap-1.5 text-2xs text-warning" v-tooltip.top="unplacedRefusal">
                    <Icon name="exclamation-triangle" class="mt-px shrink-0 text-[0.6rem]" aria-hidden="true" />
                    <span class="line-clamp-2">{{ unplacedRefusal }}</span>
                </p>
                <template v-if="accounts.length > 1">
                    <!-- Labelled as a group: the header above names the PROVIDER, which is what a sighted reader
                         needs beside a screen of another provider's models, and these rows still have to announce
                         what they are.

                         NO FRAME PER ROW. Boxing each account drew three hard rectangles into a panel that already
                         has a border, a header rule and a model list above it, and the frames carried no meaning —
                         every row had one, chosen or not. What actually needs marking is the one row in effect, and
                         the tint does that alone. Hover is what says the rest are choosable.

                         These ARE the model list's rows, one panel down, so they are drawn by the same utility at
                         the same metrics: `.ui-row-select` full-bleed at `px-3 py-1.5`, square rather than rounded.
                         An inset pill under a run of full-width rows reads as a different KIND of list — which is
                         the one thing these are not. -->
                    <div class="-mx-3 flex flex-col" role="group" aria-label="Account">
                        <button
                            v-for="a in accountRows"
                            :key="a.id"
                            type="button"
                            class="ui-row-select flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-xs max-md:min-h-11"
                            :class="{ 'ui-row-select-on': activeAccountId === a.id }"
                            :disabled="streaming"
                            @click="conversation.selectAccount(a.id)"
                        >
                            <!-- Name over identity, both truncating: the row grows by a line only for accounts
                                 that need one, so the common single-account case is the same 8-high row it always
                                 was.

                                 THE REFUSAL TAKES THE SECOND LINE when there is one, rather than adding a third.
                                 The line it displaces exists to tell two similar accounts apart, and that is a
                                 strictly smaller question than "this one turned your last turn away" — which the
                                 name above still answers well enough to pick by. Three lines in a popover row
                                 would also push the ring out of the reader's line, and the ring is the thing this
                                 line exists to argue with. -->
                            <span class="flex min-w-0 flex-col items-start leading-tight">
                                <span class="max-w-full truncate text-content">{{ a.label }}</span>
                                <!-- Truncated on the row and whole on hover: the line leads with the condition
                                     and its age, which is what decides the click, and tails into the provider's
                                     own sentence, which is the part that says what to do about it. -->
                                <span v-if="a.refused" class="flex max-w-full items-center gap-1 text-2xs text-warning" v-tooltip.top="a.refused">
                                    <Icon name="exclamation-triangle" class="shrink-0 text-[0.6rem]" aria-hidden="true" />
                                    <span class="truncate">{{ a.refused }}</span>
                                </span>
                                <span v-else-if="a.subtitle" class="max-w-full truncate text-2xs text-subtle">{{ a.subtitle }}</span>
                            </span>
                            <!-- How much of this account's tightest limit pool is spent, so the switch decision is
                                 informed before it costs a turn. Absent ⇒ no reading at all (never measured, and
                                 not obtainable for this plan) — which is a different thing from a measured zero. -->
                            <UsageRing v-if="a.headroom" :headroom="a.headroom" class="ml-auto" />
                            <Icon
                                v-if="a.needsReauth"
                                name="exclamation-triangle"
                                class="shrink-0 text-2xs text-warning"
                                :class="{ 'ml-auto': !a.headroom }"
                                v-tooltip.top="a.detail ?? 'This account needs to be reconnected'"
                            />
                        </button>
                    </div>
                </template>

                <!-- The connections behind a routed provider: shown, not offered. See routedRows. -->
                <template v-if="routedRows.length > 0">
                    <!-- Unframed like the account rows above, and for a second reason on top of the weight: these
                         are not controls. A box that looks exactly like the one you can click, but doesn't, is
                         worse than no box. -->
                    <div class="-mx-3 flex flex-col" role="group" aria-label="Subscription">
                        <div v-for="a in routedRows" :key="a.name" class="flex min-h-8 min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
                            <span class="min-w-0 truncate text-content">{{ a.label }}</span>
                            <UsageRing v-if="a.headroom" :headroom="a.headroom" class="ml-auto" />
                        </div>
                    </div>
                    <p class="text-2xs text-subtle">
                        {{ routedRows.length === 1 ? `Signed in through your subscription` : `Turns are spread across these automatically` }}
                    </p>
                </template>

                <!-- Harness axis (codex/grok): the provider's own runtime, or its model through the Claude Code
                     harness. Separate from the model — the same subscription ids run under either. -->
                <div v-if="harnessChoosable" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Harness</span>
                    <div class="flex items-center gap-1">
                        <button
                            v-for="h in harnessOptions"
                            :key="h.value"
                            type="button"
                            class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                            :class="{ 'composer-active': harness === h.value }"
                            :disabled="streaming"
                            :aria-pressed="harness === h.value"
                            @click="conversation.selectHarness(h.value)"
                        >
                            {{ h.label }}
                        </button>
                    </div>
                </div>

                <!-- Codex reasoning is always on (no toggle); extended thinking is a Claude knob. -->
                <div v-if="provider === `claude`" class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Extended thinking</span>
                    <button
                        type="button"
                        class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                        :class="{ 'composer-active': thinking }"
                        @click="conversation.setThinking(!thinking)"
                        :aria-pressed="thinking"
                        aria-label="Toggle extended thinking"
                    >
                        <Icon name="bolt" class="text-2xs" />
                        <span>{{ thinking ? "On" : "Off" }}</span>
                    </button>
                </div>

                <!-- FAST SPEED. Offered only where all three conditions hold (fastAllowed: the Claude Code loop, a
                     first-party route, a model whose catalog row publishes the `fast` badge) — so it appears and
                     disappears with the model rather than sitting greyed out with an explanation nobody reads. The
                     toggle stands on its own: a standing caption under a switch is read once and skipped from then
                     on, and the only line worth the space is the conditional one below it, which reports what the
                     harness actually did rather than restating what the switch is. -->
                <div v-if="fastOffered" class="flex flex-col gap-1">
                    <div class="flex items-center justify-between gap-2">
                        <span class="text-2xs font-medium uppercase tracking-wide text-muted">Fast speed</span>
                        <button
                            type="button"
                            class="composer-ghost h-7 gap-1 px-2.5 text-2xs font-medium max-md:h-10"
                            :class="{ 'composer-active': fast }"
                            @click="conversation.setFast(!fast)"
                            :aria-pressed="fast"
                            aria-label="Toggle fast speed"
                        >
                            <Icon name="bolt" class="text-2xs" />
                            <span>{{ fast ? "On" : "Off" }}</span>
                        </button>
                    </div>
                    <!-- What the harness actually did with the ask. Only ever shown when it DIFFERS from what was
                         asked for: agreeing with the toggle is what the toggle already says, and a notice under a
                         working control trains people to ignore notices. -->
                    <span v-if="fastSpeedNotice !== undefined" class="text-2xs text-subtle">{{ fastSpeedNotice }}</span>
                </div>

                <!-- The honest half of the choice: what this runtime can't do, named before the user relies on it.
                     Chips rather than prose — the list is short, unordered, and each item is a control that would
                     otherwise appear to work. -->
                <div v-if="limitations.length > 0" class="flex flex-col gap-1">
                    <span class="text-2xs font-medium uppercase tracking-wide text-muted">Not available here</span>
                    <div class="flex flex-wrap gap-1">
                        <span v-for="limit in limitations" :key="limit" class="rounded border border-line px-1.5 py-0.5 text-2xs text-subtle">{{
                            limit
                        }}</span>
                    </div>
                </div>
            </div>
        </template>
    </ModelPicker>
</template>
