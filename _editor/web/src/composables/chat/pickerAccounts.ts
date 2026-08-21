import { type AgentHarness, type AgentProvider, type KeyedProvider, reportsPlanLimits } from "@intentic/sandbox-contract";
import { computed, type Ref, ref } from "vue";
import { relativeTime } from "./catalog";
import { providerDisplayLabel } from "./providerCatalog";
import { providerRefusals, translatorAccounts } from "./providerAccounts";
import {
    formatAge,
    liveUsage,
    PLAN_LIMIT_BAND_LABEL,
    PLAN_LIMIT_BANDS,
    type PlanHeadroom,
    planHeadroom,
    type PlanLimitBand,
    planLimitBand,
    planLimitBandTone,
    refusalNote,
    usagePercent,
} from "./usageStatus";
import { accountsOf, refreshConnections, subscriptionOnly } from "./useChat";

/* WHICH CREDENTIAL AND WHICH RUNTIME SERVE THE TURN, the derivation behind the model picker's footer, shared by
 * the two surfaces that ask it: the chat composer (bound to a conversation) and the shell's own picker opened by
 * an extension (bound to whatever that extension is about to run).
 *
 * It is a composable rather than the component's own body because both callers need one thing BEFORE the markup
 * exists, whether there is anything here to show at all, and each wraps the block in its own footer. A caller
 * drawing a border and padding around an empty answer is the one defect this seam has to make impossible.
 *
 * Everything below reads MODULE state (the sandbox's accounts, its refusals, its usage readings) narrowed by the
 * provider it is handed. Nothing here belongs to a conversation: a conversation only picks WHICH of these serves
 * its next turn. */

/* HOW MANY ACCOUNT ROWS A FOOTER DRAWS BEFORE IT FOLDS INTO A SUMMARY.
 *
 * Three Claude logins want to be three rows: every one is on screen, every one is one click away, and a
 * disclosure over them would hide something that already fitted. Thirty-four pooled Google sign-ins want none of
 * them, they are one address per row differing in a digit nobody chose, in the routed case they are not
 * individually choosable at all, and drawn in full they pushed the model list (the thing this panel is FOR) clean
 * off the top of the screen, which is the state this constant exists to end.
 *
 * Five is where a column stops being scannable at a glance and starts being a list you read, and it is also the
 * point past which a footer costs more vertical room than the catalog above it. */
export const ACCOUNT_LIST_LIMIT = 5;

/* WHAT A FOLDED LIST SAYS IN PLACE OF ITS ROWS, counts by band, the same unit the Usage tab's capacity bar is
 * built from (planLimitBand), and for the reason stated there: averaging thirty-four separate pools produces a
 * number that describes no account and hides the only one that matters. "28 with room · 6 spent" survives the
 * fold; a mean does not.
 *
 * Banded off the rings the rows have ALREADY been given, so the summary and the list it hides cannot disagree,
 * the reader opens the fold expecting to find the six red arcs this line just promised. */
export interface CapacityCount {
    readonly band: PlanLimitBand;
    readonly count: number;
    readonly label: string;
    readonly tone: string;
}

export const capacityCounts = (
    provider: AgentProvider,
    rows: readonly { readonly headroom: PlanHeadroom | undefined }[],
): readonly CapacityCount[] => {
    const readable = reportsPlanLimits(provider);
    const counts = new Map<PlanLimitBand, number>();
    for (const row of rows) {
        const band = planLimitBand({ percent: row.headroom?.percent, readable });
        counts.set(band, (counts.get(band) ?? 0) + 1);
    }
    // Worst first (PLAN_LIMIT_BANDS' own order), and `none` left out, a plan that publishes no limits is the
    // absence of a reading rather than a degree of fullness, exactly as the capacity bar treats it.
    return PLAN_LIMIT_BANDS.flatMap((band) => {
        const count = counts.get(band) ?? 0;
        return count === 0 || band === `none` ? [] : [{ band, count, label: PLAN_LIMIT_BAND_LABEL[band], tone: planLimitBandTone(band) }];
    });
};

/* THE FILTER OVER A FOLDED LIST, matched against everything a row SHOWS: its name and the identity line under it.
 * A pool of near-identical gmail addresses is looked up by the part the reader remembers, "spam12", "radrat",
 * and on rows whose label is the provider's own word for the account, that part lives only in the identity. */
export const matchAccounts = <T extends { readonly label: string; readonly subtitle?: string | undefined }>(
    rows: readonly T[],
    query: string,
): readonly T[] => {
    const needle = query.trim().toLowerCase();
    return needle === `` ? rows : rows.filter((row) => `${row.label} ${row.subtitle ?? ``}`.toLowerCase().includes(needle));
};

export const usePickerAccounts = (provider: Ref<AgentProvider>, harness: Ref<AgentHarness>) => {
    const accounts = computed(() => accountsOf(provider.value));

    // The harness axis, shown as footer chips for codex/grok (claude is always its own loop). Both chips NAME
    // the runtime they select, the native one is labelled for the provider whose loop it actually is
    // ("ChatGPT", "Grok"), never "Default", which would say nothing about what runs while sitting opposite a
    // chip that does.
    const harnessOptions = computed<readonly { label: string; value: AgentHarness }[]>(() => [
        { label: providerDisplayLabel(provider.value), value: `native` },
        { label: `Claude Code`, value: `claude-code` },
    ]);
    /* NO CHIP FOR GEMINI, and its absence is the honest version of what used to be here. The pair of chips is an
     * offer, and offering a Claude Code loop for Google was offering a turn that cannot complete: that loop
     * announces itself in every request and Google's channel refuses on the announcement, whatever account pays.
     * A chip whose only outcome is a refusal is worse than no chip, it reads as a working alternative someone
     * might reasonably pick when the other one is slow. Gemini runs its own loop, and the contract now says so
     * for every surface at once (capabilitiesOf), so there is nothing here to choose. */
    const harnessChoosable = computed(() => provider.value === `codex` || provider.value === `grok`);

    /* THE SUBSCRIPTIONS THIS SELECTION WOULD RUN ON INSTEAD, for the three providers that own no account and for
     * Grok under the Claude Code harness. They are not a picker: CLIProxyAPI holds every auth file and balances
     * turns across them, so there is nothing here to choose and these rows are read-only.
     *
     * They are listed anyway, because the alternative was silence. This footer showed an account list for Claude
     * and nothing whatsoever for ChatGPT, Kimi or Google, which reads as "this provider has no connections", one
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

    /* WHEN THIS PROVIDER LAST REFUSED A TURN, read against everything that has happened since, the observed half
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
     * which is where the Agent tab puts an unattributable one too, the alternative was the state this whole change
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

    // Names shared by more than one connected account, the rows a name alone cannot tell apart.
    const ambiguousLabels = computed(() => {
        const seen = new Map<string, number>();
        for (const entry of accounts.value) {
            seen.set(entry.label, (seen.get(entry.label) ?? 0) + 1);
        }
        return new Set([...seen].filter(([, count]) => count > 1).map(([label]) => label));
    });

    /* The account rows, each decorated with the two things a switch decision actually turns on.
     *
     * WHICH ONE THIS IS, the identity the provider reported (Claude returns the email + organization with the
     * token), under the name, because the name is the user's to change and two of them can read the same. Failing
     * that, and only when two rows DO read the same, the date it was connected: a weak difference, but picking
     * between two lines that both say "Claude" is not a choice, it's a coin flip. Quiet otherwise, a single
     * self-explaining account earns no second line.
     *
     * HOW MUCH IS LEFT, how much of its TIGHTEST limit pool is spent, which is the whole point of the account list
     * being a list and used to cost a turn to find out. Drawn as the same ring the connection list and the composer
     * chip use for this number, rather than as the bare percentage it was: three percentages down a column are read
     * one at a time and compared by arithmetic, where three arcs are compared at a glance, which is the only
     * question being asked here (which of these has the most room?). The exact figure, its per-pool breakdown and
     * how old the reading is stay one hover away, the card UsageRing opens BESIDE the row, so reading one
     * account's pools never covers the rows it is being compared against, and a row with no ring at all means no
     * reading, never "empty".
     *
     * WHETHER IT CAN RUN AT ALL, which the ring cannot answer and had been left to find out by trying. A poll and
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
                // of the two whenever no turn has ended in this tab since, which is most of the time.
                headroom: planHeadroom(liveUsage(entry.id, entry.usage)),
                /* Only while it STANDS, and only on the account it names. A refusal something since has answered is
                 * history, and history does not belong on a row someone is about to click; a refusal the daemon
                 * could not attribute (a routed turn) belongs to no row here at all. Both of those are the Agent
                 * tab's to report in full, this footer carries the one fact that changes the click. */
                refused: note?.current === true && refusal?.account === entry.id ? note.line : undefined,
            });
        });
    });

    /* The banded summary each list wears once it is long enough to fold. Derived here rather than in the component
     * because it is a reading of the same rows, taken at the same instant: the count and the arcs it stands in for
     * are one fact, and a footer that computed them separately could report five spent accounts above six red
     * rings. Cheap enough to keep live, the fold only hides the rows, not the readings behind them. */
    const accountCapacity = computed(() => capacityCounts(provider.value, accountRows.value));
    const routedCapacity = computed(() => capacityCounts(routedProvider.value ?? provider.value, routedRows.value));

    /* ---- how old these numbers are, and the way to make them new ------------------------------------------------
     *
     * The rings are refreshed by the panel opening (ModelPicker's onMounted), which is what stopped them being as
     * old as the browser tab. This says so, and gives the reader the one move that seam cannot make for them.
     *
     * THE OLDEST READING ON SCREEN, not the newest and not the active account's: the header qualifies every ring
     * under it, and a header that reports its freshest row would vouch for a stale one sitting directly beneath.
     * Undefined when nothing has been measured at all, the control still shows, because "no reading yet" is
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
     * account, a seat downgraded, a plan swapped, a limit spent on another machine, and is asking whether what
     * they can see survived it. Answering from the last minute would hand back the number they pressed the button
     * to doubt. Forced, it costs one free round-trip per account and the rings redraw under the cursor.
     *
     * Every connection, not this provider's: the list above this footer spans every provider and locks the ones
     * with no credential, so a read that covered only the session's own would leave the rest of the panel as stale
     * as it was. */
    const measuring = ref(false);
    // The age is on screen as the button's own label, so the spoken name has to carry it too, a bare
    // "Re-measure plan limits" tells a screen-reader user what the control does and nothing about whether to press
    // it, which is the only question the sighted version answers at a glance.
    const remeasureLabel = computed(() =>
        measuredAt.value === undefined ? `Measure plan limits` : `Re-measure plan limits, measured ${formatAge(measuredAt.value)}`,
    );
    const remeasure = async (): Promise<void> => {
        measuring.value = true;
        try {
            await refreshConnections(true);
        } finally {
            measuring.value = false;
        }
    };

    /* Whether this block says anything at all, the question each caller has to answer before it draws a footer
     * around it. A single account is not a list (there is nothing to switch to), which is why the account clause
     * counts to two; a standing refusal earns the block on its own, since it is the one fact here that changes a
     * decision even when nothing is choosable. */
    const hasContent = computed(
        () => accounts.value.length > 1 || routedRows.value.length > 0 || harnessChoosable.value || unplacedRefusal.value !== undefined,
    );

    return {
        accounts,
        accountRows,
        accountCapacity,
        routedRows,
        routedCapacity,
        unplacedRefusal,
        harnessOptions,
        harnessChoosable,
        measuredAt,
        measuring,
        remeasureLabel,
        remeasure,
        hasContent,
    };
};
