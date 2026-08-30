<script setup lang="ts">
import { type Computer, type MachineSandboxOp, type MachineWatcher, watcherStalled } from "@intentic/sandbox-contract";
import {
    Button,
    ConfirmDialog,
    groupNeedsAttention,
    InfoHint,
    MachineDetail,
    MachineRunLog,
    type MachineSandboxGroup,
    Notice,
    type NoticeModel,
    RowGroup,
    RowNote,
    sandboxGroups,
    type SandboxVerb,
    sandboxVerbPrompt,
    SandboxVerbs,
    SearchBar,
    SkeletonRows,
    StatusBadge,
    StatusTally,
    type StatusVariant,
    type TallyItem,
    timeAgo,
    VERB_LABEL,
} from "@intentic/ui";
import { noticeFrom, useNow } from "@intentic/ui/async";
import { computed, onMounted, ref, watch } from "vue";
import MachineRunners from "../../components/MachineRunners.vue";
import { type RouteLocationRaw, RouterLink, useRoute } from "vue-router";
import BridgeTokensCard from "./BridgeTokensCard.vue";
import {
    type ComputerScopes,
    computerDoors,
    lastSeenNote,
    machineFacts,
    type ManageBlock,
    manageBlock,
    osLabel,
    osTitle,
    syncAgentBehind,
} from "./computerFacts";
import DesktopSyncCard from "./DesktopSyncCard.vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { manageMachineSandbox, reportStale, useComputers } from "../../composables/sandbox/useComputers";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { useSandboxVersion } from "../../composables/sandbox/useSandboxVersion";
import { desktopApp } from "../../environments/desktop";

/* The Sandbox hub's "Computers" tab: what is on the other end of this sandbox.
 *
 * It replaces the old "Sync" tab, which was a single enrollment card, and the replacement is the point. That card
 * answered "is a machine paired" and then, for everything a person actually arrives asking, which folder is this
 * syncing into, which ports did I get on localhost, why is my dev server not there: printed the name of a
 * terminal command. A machine-level view is also the only honest shape for the facts: one laptop pairing three
 * sandboxes used to render as three partial cards on three different pages, and its ports contend across all of
 * them.
 *
 * ONE COMPUTER, ONE ROW; ONE SANDBOX, ONE ROW INSIDE IT. The tab shipped with each machine's sandboxes printed
 * twice: folders and ports under "Desktop sync", containers and their buttons under "Sandboxes on this
 * computer": under two different names for the same box, each in its own filled and bordered block inside the
 * page's own card. Two of everything, three surfaces deep, all of it the same grey. <MachineDetail> now joins the
 * two halves and this page hands it the containers and the verbs; what is left here is what a row says about the
 * MACHINE, which is the half that view cannot know.
 *
 * Enabling sync is still the DesktopSyncCard below, unchanged: adding a computer is a different job from reading
 * the ones you have, and that card already does it well.
 *
 * Arriving from the Workspace "Open in local editor" shortcut (?enable=desktop-sync) still flashes that card. */

const route = useRoute();
const highlight = ref(false);
const { computers, error, isLoading, refetch } = useComputers();
/* Until the list lands, "no computer is paired" is a guess dressed as a fact, and the wrong one for anybody who
 * has a laptop paired, who then reads an invitation to pair the laptop they already paired. The outline holds
 * the row's shape instead. Only the first read: this query polls, and an outline that returned every ten
 * seconds would be worse than the empty state ever was. */
const outline = useSandboxOutline(isLoading);
// The list query's bare message, in the words of the page that asked for it.
const computersNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list your computers.`, detail: error.value },
);

/* One clock for the whole render, so every row's staleness is judged against the same instant rather than each
 * against the moment its own computed happened to run, and the app's one clock, so it stops with this tab.
 *
 * QUANTISED, and that is not a detail: the app's clock ticks every second, and every derivation on this page
 * hangs off it. `label` reads it, `sorted` sorts by `label`, `rows` maps `sorted` and calls `sandboxGroups` per
 * machine, and `shown`, `tally`, `blocks` and `autoOpenMachine` all read `rows`: so the entire list, every
 * machine's port-and-folder grouping included, was rebuilt once a second and handed to <MachineDetail> as fresh
 * objects, for data that arrives every ten. Nothing on this page needs finer time than that, because everything
 * that reads the clock is a threshold a MINUTE wide (reportStale, watcherStalled). Rounding to the poll interval
 * leaves those answers unchanged to within ten seconds and stops the cascade dead: the computed still runs each
 * tick, returns the same number, and nothing downstream of it moves. */
const CLOCK_STEP_MS = 10_000;
const ticking = useNow();
const now = computed(() => Math.floor(ticking.value / CLOCK_STEP_MS) * CLOCK_STEP_MS);

/* The release this sandbox knows about: the SAME value behind its own update badge, because one release stamps
 * the daemon, the image and both machine agents alike. It rides the shared /info query, so putting agent
 * staleness on these rows costs no request: the answer is already in the cache this tab's chip reads.
 *
 * Undefined on a sandbox that has not reached the registry (or is a dev build and never will), which is what
 * makes the version parts render exactly as they did before rather than guessing. */
const { latest } = useSandboxVersion();
onMounted(() => {
    if (route.query[`enable`] === `desktop-sync`) {
        highlight.value = true;
        setTimeout(() => document.getElementById(`desktop-sync`)?.scrollIntoView({ behavior: `smooth`, block: `center` }), 50);
    }
});

/* Each gap is a different errand, so each gets its own sentence rather than one "unavailable". `scope-off` is the
 * only one the reader closes in a single click, so it says which switch: the same way the host agent's own
 * refusals name the control rather than reporting a broken sandbox. */
const GAP_TEXT: Record<NonNullable<Computer[`gap`]>, string> = {
    offline: `Asleep or offline. Nothing to read from it right now.`,
    "scope-off": `Turn on "Run commands" in this computer's capability card to see what it is running.`,
    "no-agent": `Reachable, but it has no sync agent, so nothing here knows its folders or ports.`,
    unreported: `Enrolled, but it hasn't reported yet. An agent from before machine reports never will. Re-run its install to update it.`,
};

/* THIS TAB USES THREE SIZES, as a rule rather than a habit: 14px for the one thing that names an entry (the
 * computer), 12px for everything a person READS: a path, a port, a sentence, a verb, and 11px for the labels
 * and ids that only have to be findable. It shipped with nearly all of it at 11px, paths and sentences included,
 * which is what "the sizes feel off" turns out to mean once measured: there was no scale, just one small size
 * with two exceptions.
 *
 * The smallest of the three, shaped like a heading: it divides ONE computer's entry rather than the page, so it
 * stays under the group's own label (ui.sectionLabel), but it has to read as a heading, which the plain
 * `text-2xs text-muted` it replaced did not. */
const SUBHEAD = `text-2xs font-semibold uppercase tracking-wide text-subtle`;

/* HOW THIS SANDBOX REACHES THE MACHINE: one tag per door, tinted rather than outlined. A border here put a
 * third rectangle inside a card that already had two, for two words; a wash of the ink says "this is a tag" with
 * no edge to add to the pile. */
const DOOR = `inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2 py-0.5 text-2xs text-muted`;

// Whether this computer's watcher is up but no longer making rounds. Both the badge and the detail block below
// ask it, off the one rule the terminal uses (watcherStalled), so a row and `intentic-machine status` cannot
// disagree about the same machine.
const watcherHalted = (computer: Computer): boolean => computer.report !== undefined && watcherStalled(computer.report.watcher, now.value);

const tone = (computer: Computer): StatusVariant => {
    if (computer.gap !== undefined) {
        return computer.gap === `offline` ? `neutral` : `warning`;
    }
    // A stalled watcher is the same errand as a stopped one: nothing is reaching that machine's ports or clones
    //, and it is the one a green row hides best, because the process it names is alive.
    if (reportStale(computer, now.value) || computer.report?.watcher.running === false || watcherHalted(computer)) {
        return `warning`;
    }
    return `success`;
};

/* THE BADGE'S WORD, and it now agrees with the badge's COLOUR. A machine whose sync agent has died is amber:
 * `tone` has always said so, because nothing is reaching its folders or ports, and said "live" in that amber,
 * which is the one pairing of word and colour a reader cannot act on. It is the same errand as a gap: something
 * on that computer wants attention. */
const label = (computer: Computer): string => {
    if (computer.gap !== undefined) {
        return computer.gap === `offline` ? `offline` : `needs attention`;
    }
    if (reportStale(computer, now.value)) {
        return `gone quiet`;
    }
    return computer.report?.watcher.running === false || watcherHalted(computer) ? `needs attention` : `live`;
};

/* THE MACHINES WORTH READING, FIRST. Sorting the list by name alone put an offline box and a stale one above the
 * laptop actually serving folders and ports: three screens of "nothing to read from it right now" before the
 * card the reader came for. State leads, name breaks ties, so the order only ever changes when a machine's state
 * does, which is a change worth noticing rather than a list that reshuffles under the cursor.
 *
 * Live before needs-attention on purpose: a machine that wants something is one quiet sentence, and its badge
 * already finds the eye, while a live one is the whole point of the page. */
const RANK: Record<string, number> = { live: 0, "needs attention": 1, "gone quiet": 2, offline: 3 };

const sorted = computed(() => computers.value.toSorted((a, b) => (RANK[label(a)] ?? 9) - (RANK[label(b)] ?? 9) || a.label.localeCompare(b.label)));

/* --- ONE ROW PER COMPUTER, DERIVED ONCE ------------------------------------------------------------------
 *
 * The tab used to draw every fact about every sandbox on every machine at once. One laptop running four of them
 * filled the screen with four folders, four port stacks, four image lines and twenty-four buttons, and the row
 * somebody came for was somewhere in the middle of it. Three machines was a page nobody could scan.
 *
 * So a machine is a LINE that says what is under it, and the list under it opens when it is asked for. That
 * turns "what does this row say" into a real derivation: how many sandboxes, how many running, how many want
 * something, and it is done once here rather than four times in the template, because the same grouping the
 * view is about to draw has to be counted to say any of it. */
const machineGroups = (computer: Computer): MachineSandboxGroup[] =>
    computer.report === undefined ? [] : sandboxGroups(computer.report.pairings, computer.report.ports, computer.report.sandboxes);

const has = (needle: string, ...fields: (string | undefined)[]): boolean =>
    fields.some((field) => field !== undefined && field.toLowerCase().includes(needle));

// What one sandbox answers to. The port numbers are in here because "which machine has 8788" is the single most
// common thing anybody comes to this tab to find out, and it was previously answerable only by reading.
const groupMatches = (group: MachineSandboxGroup, needle: string): boolean =>
    has(needle, group.title, group.subtitle, group.sandboxId, group.sandbox?.slug, group.sandbox?.image, group.folder?.localDir) ||
    group.ports.some((port) => String(port.port).includes(needle));

interface ComputerRow {
    readonly computer: Computer;
    readonly groups: readonly MachineSandboxGroup[];
    /** The folded line's counts, uncoloured. */
    readonly facts: readonly string[];
    /** The folded line's reasons to open it. */
    readonly warnings: readonly string[];
    /** Sandbox ids this machine should unfold on arrival: the one you are using, and anything the filter hit. */
    readonly open: readonly string[];
    /** The machine's watcher with this render's stall verdict already on it, absent on a machine that never
     *  reported. Derived HERE rather than in the template, where `{ ...watcher, stalled }` was a fresh object
     *  every render and re-rendered the whole of <MachineDetail> beneath it for a fact that changes about once
     *  a minute. */
    readonly watcher: (MachineWatcher & { readonly stalled: boolean }) | undefined;
}

/* WHICH ROW IS THE SANDBOX YOU ARE LOOKING AT. The container's slug on its machine is the leading label of the
 * daemon's own hostname: the same derivation the sandbox switcher uses for its teardown command, and the same
 * one the setup CLI applies when it names the container.
 *
 * It matters because this view can stop and delete the very sandbox serving it. That is a legitimate thing to
 * want and a terrible thing to do by accident, so the row says so and the confirmation names it. */
const { daemonUrl } = useSandbox();
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));
const isSelf = (computer: Computer, group: MachineSandboxGroup): boolean => computer.hostId !== undefined && group.sandbox?.slug === ownSlug.value;

// What the reader typed. Lower-cased once here rather than per comparison, and blank until they type: an empty
// filter must never narrow anything.
const query = ref(``);
const needle = computed(() => query.value.trim().toLowerCase());

const rows = computed<ComputerRow[]>(() =>
    sorted.value.map((computer) => {
        const groups = machineGroups(computer);
        const running = groups.filter((group) => group.sandbox?.running === true).length;
        const attention = groups.filter(groupNeedsAttention).length;
        const facts: string[] = [];
        const warnings: string[] = [];
        if (groups.length > 0) {
            facts.push(groups.length === 1 ? `1 sandbox` : `${groups.length} sandboxes`);
        }
        if (running > 0) {
            facts.push(`${running} running`);
        }
        if (attention > 0) {
            warnings.push(attention === 1 ? `1 needs attention` : `${attention} need attention`);
        }
        /* The watcher is a fact about the MACHINE rather than any row under it, so it belongs on the machine's
         * own line, and it is the failure this whole area exists to surface: a dead watcher leaves every row
         * beneath it reading exactly as it did the moment before. */
        if (computer.report !== undefined && (computer.report.watcher.running === false || watcherHalted(computer))) {
            warnings.push(`sync agent stopped`);
        }
        const watcher = computer.report?.watcher;
        return {
            computer,
            groups,
            facts,
            warnings,
            open: groups
                .filter((group) => isSelf(computer, group) || (needle.value !== `` && groupMatches(group, needle.value)))
                .map((group) => group.sandboxId),
            watcher: watcher === undefined ? undefined : { ...watcher, stalled: watcherStalled(watcher, now.value) },
        };
    }),
);

/* THE FILTER NARROWS MACHINES AND UNFOLDS ROWS: it does not hide rows inside a machine.
 *
 * A port that did not reach localhost is explained by naming the sandbox that took it, and that sentence links
 * to the taker's own row. Filtering rows out from under a machine would cut exactly those links, so a search for
 * "8788" would answer with a row whose explanation points at something no longer on screen. Narrowing the list
 * of machines and opening what matched keeps every cross-reference intact and still puts the answer in front of
 * the reader. */
const shown = computed<ComputerRow[]>(() => {
    const text = needle.value;
    if (text === ``) {
        return rows.value;
    }
    return rows.value.filter(
        (row) =>
            has(text, row.computer.label, row.computer.key, osLabel(row.computer), row.computer.hostId, row.computer.report?.hostname) ||
            row.groups.some((group) => groupMatches(group, text)),
    );
});

/* Only once there is something to hunt through. A search box over two rows is a control that costs more to
 * notice than the reading it saves; over a dozen it is the fastest way to the one you want. */
const FILTER_FLOOR = 3;
const showFilter = computed(() => rows.value.length > 2 || rows.value.reduce((total, row) => total + row.groups.length, 0) > FILTER_FLOOR);

/* THE ORIENTATION LINE: "is anything wrong right now", answered before a single row is parsed. One measure
 * (sandboxes) split by state, which is what this component is for; the machine count is the group's own, beside
 * its label. Running is `always` because a board that renders as nothing at all reads as broken. */
const tally = computed<TallyItem[]>(() => {
    const groups = rows.value.flatMap((row) => row.groups);
    return [
        { label: `running`, value: groups.filter((group) => group.sandbox?.running === true).length, variant: `success`, always: true },
        { label: `stopped`, value: groups.filter((group) => group.sandbox?.running === false).length, variant: `neutral` },
        { label: `need attention`, value: groups.filter(groupNeedsAttention).length, variant: `warning` },
    ];
});

/* WHICH MACHINES ARE UNFOLDED. The same two-set rule the sandbox rows use, for the same reason: this list
 * re-derives itself every ten seconds and must not move under the pointer.
 *
 * What opens itself is the machine running the sandbox you are reading this in: failing that, the first one
 * with anything to show, plus anything the filter matched. Deliberately not "every machine with a warning": the
 * folded line already states the warning, and opening three machines to say so is the wall again. */
const openMachines = ref(new Set<string>());
const foldedMachines = ref(new Set<string>());
const expandable = (row: ComputerRow): boolean => row.computer.report !== undefined;
const autoOpenMachine = computed(() => {
    const withReport = rows.value.filter(expandable);
    const self = withReport.find((row) => row.groups.some((group) => isSelf(row.computer, group)));
    const matched = needle.value === `` ? [] : shown.value.filter(expandable).map((row) => row.computer.key);
    return new Set([...(self === undefined ? withReport.slice(0, 1) : [self]).map((row) => row.computer.key), ...matched]);
});
const machineOpen = (row: ComputerRow): boolean =>
    expandable(row) &&
    (openMachines.value.has(row.computer.key) || (autoOpenMachine.value.has(row.computer.key) && !foldedMachines.value.has(row.computer.key)));
const toggleMachine = (row: ComputerRow): void => {
    const key = row.computer.key;
    const shutting = machineOpen(row);
    openMachines.value = new Set([...openMachines.value].filter((seen) => seen !== key));
    foldedMachines.value = new Set([...foldedMachines.value].filter((seen) => seen !== key));
    const target = shutting ? foldedMachines : openMachines;
    target.value = new Set([...target.value, key]);
};
// A machine the filter newly matched opens even if the reader folded it earlier, for the same reason a matched
// sandbox row does: a filter that narrows to one machine and leaves it shut reads as a filter that found nothing.
watch(
    () => [...autoOpenMachine.value].join(`|`),
    (keys) => (foldedMachines.value = new Set([...foldedMachines.value].filter((key) => !keys.split(`|`).includes(key)))),
);

/* The management buttons, shown only where they can work: the machine is reachable as a connected computer right
 * now, and the row in front of us is a container rather than a pairing nothing on that machine answers for. The
 * daemon adds no judgement and neither does this: a click travels to the machine, and the machine's own refusal
 * (the "Manage sandboxes on this computer" switch is off, say) is shown under the row verbatim. */
const manageable = (computer: Computer, group: MachineSandboxGroup): boolean =>
    computer.hostId !== undefined && computer.online === true && group.sandbox !== undefined;

/* WHY A ROW HAS NO BUTTONS, SAID BEFORE ANYONE GOES LOOKING FOR THEM (computerFacts.ts holds the rule).
 *
 * This tab and the desktop app's manager window draw the same containers with the same verbs from the same kit,
 * and a reader with a machine paired by the desktop app still saw none of it here: desktop sync never reports a
 * box's containers, so the row arrived with folders, ports, and an empty list where the sandboxes should be. The
 * remedy (connect the machine as a computer, grant it the sandbox switch) was already built and nowhere named,
 * which is the whole of the gap between the two apps.
 *
 * The switches are read from the capability the daemon already put an id on, so "Manage sandboxes is off" is said
 * BEFORE the click rather than arriving as the machine's refusal after one. The machine still has the last word;
 * this only stops the page being silent about a no it could see coming. */
const { capabilities } = useCapabilities();
const scopesOf = (computer: Computer): ComputerScopes | undefined =>
    computer.hostId === undefined ? undefined : capabilities.value.find((capability) => capability.id === computer.hostId)?.config;
// Derived once per list rather than per mention: the template asks a row's block four times (whether to draw the
// line, its words, whether it has a destination, and where), and each answer is a scan of the capability list.
const blocks = computed(() => new Map(sorted.value.map((computer) => [computer.key, manageBlock(computer, scopesOf(computer))])));
const blockOf = (computer: Computer): ManageBlock | undefined => blocks.value.get(computer.key);

/* Each block is a different errand, so each gets its own sentence: the same rule GAP_TEXT follows above. The
 * first names what desktop sync IS rather than what is broken, because nothing is: a machine syncing files
 * perfectly well is exactly the row this reaches. */
const BLOCK_TEXT: Record<ManageBlock[`kind`], string> = {
    connect: `Desktop sync carries folders and ports, never containers, so its sandboxes can't be started, updated or removed from here. Connect it as a computer for the same buttons the desktop app's own window has.`,
    "sandboxes-off": `Turn on "Manage sandboxes on this computer" in this computer's capability card to use the buttons below.`,
    "remove-off": `Removing a sandbox needs "Remove sandboxes from this computer" on this computer's capability card. Everything else below already works.`,
};
const BLOCK_ACTION: Record<ManageBlock[`kind`], string> = {
    connect: `Connect this computer`,
    "sandboxes-off": `Open its permissions`,
    "remove-off": `Open its permissions`,
};

/* WHERE THE FIX IS. A `connect` block opens the card that ADDS a computer of this kind; the other two open the
 * connection that already exists, at its own form. Undefined when this build has no card for the machine's
 * platform (a Mac, today): the sentence is still worth saying, and a button pointing nowhere is not. */
const blockTarget = (block: ManageBlock | undefined): RouteLocationRaw | undefined => {
    if (block?.card === undefined) {
        return undefined;
    }
    const card = { name: `capabilities`, params: { card: block.card } };
    return block.kind === `connect` ? card : { ...card, query: { edit: block.connection } };
};

// What the row says and what its button offers, both keyed off the row rather than off a block the template
// would have to hold: a Vue template narrows nothing across elements, and four non-null assertions on one
// `v-if` is the kind of thing that stays correct only until somebody moves a line.
const blockText = (computer: Computer): string | undefined => {
    const block = blockOf(computer);
    return block === undefined ? undefined : BLOCK_TEXT[block.kind];
};
// Undefined when there is nowhere to send anyone: a Mac has no card to connect it with, so the sentence runs
// alone rather than beside a control that would do nothing.
const blockAction = (computer: Computer): string | undefined => {
    const block = blockOf(computer);
    return block === undefined || blockTarget(block) === undefined ? undefined : BLOCK_ACTION[block.kind];
};
// Only ever read where `blockAction` already said there is somewhere to go, so the fallback is unreachable:
// it exists because a template cannot narrow one call's result against another's.
const fixAt = (computer: Computer): RouteLocationRaw => blockTarget(blockOf(computer)) ?? { name: `capabilities` };

/* THE OTHER HALF OF THE CROSS-LINK. Read inside the desktop app, this page is one of two screens showing the same
 * machines, and the app's own is the one that needs no capability at all, because it is ON the computer it
 * manages. It cannot be linked to per row (nothing here knows which of these machines the reader is sitting at),
 * so it is said once, where the list is named. */
const inDesktopApp = desktopApp() !== undefined;

const rowKey = (computer: Computer, group: MachineSandboxGroup): string => `${computer.key}:${group.sandboxId}`;
const busy = ref<string | undefined>();
const actionError = ref<{ key: string; notice: NoticeModel } | undefined>();
const actionDone = ref<{ key: string; message: string } | undefined>();
// The running operation's output, keyed by row so leaving a log on screen while reading another row's is fine.
const runLines = ref<Record<string, string[]>>({});

/* WHICH ROW'S PANE STAYS OPEN once nothing is running. Every other op is watched and then done with: its lines
 * were progress, but `logs` is read AFTER it finishes, so the pane it filled has to survive its own run. One at a
 * time, keyed by row, because that is already how many ops this view will run at once. */
const openLog = ref<string | undefined>();
const logShown = (computer: Computer, group: MachineSandboxGroup): boolean => openLog.value === rowKey(computer, group);

// Which of this row's buttons is the one spinning. `busy` is one string for the whole tab (only one op runs at a
// time, on one machine), so the row splits its own half back out rather than each button testing the pair.
const runningVerb = (computer: Computer, group: MachineSandboxGroup): SandboxVerb | undefined => {
    const prefix = `${rowKey(computer, group)}:`;
    return busy.value?.startsWith(prefix) === true ? (busy.value.slice(prefix.length) as SandboxVerb) : undefined;
};

// The ops that end this browser's own connection when they are aimed at the sandbox serving it. Not `start`,
// which can only ever help, and not `logs`, which changes nothing at all.
const SEVERING = new Set<MachineSandboxOp>([`stop`, `restart`, `update`, `rebuild`, `rollback`, `remove`]);

/* THE STOP-MOMENT, in the app's own dialog rather than the browser's confirm(): a native popup captioned
 * "localhost says" is the wrong voice for "delete this workspace", and it cannot separate the question from
 * its consequences the way ConfirmDialog's header/body/footer does. The pending click parks here until the
 * dialog answers; everything the dialog says derives from it, so cancel is one assignment. */
const confirmingAct = ref<{ computer: Computer; group: MachineSandboxGroup; op: SandboxVerb } | undefined>();
const actPrompt = computed(() => {
    const pending = confirmingAct.value;
    if (pending === undefined) {
        return undefined;
    }
    const asked = sandboxVerbPrompt(pending.op, pending.group.title);
    return {
        // A verb with no prompt of its own only reaches this dialog by severing (stop/restart on the sandbox
        // serving this page), so the fallback header still asks a real question.
        header: asked?.header ?? `${VERB_LABEL[pending.op as Exclude<SandboxVerb, `logs`>]} ${pending.group.title}?`,
        body: asked?.body,
        // The self-warning rides the confirmation rather than replacing it: "this deletes everything" and
        // "this also closes the page you are on" are two different things to know, and the second never
        // cancels the first.
        severing: isSelf(pending.computer, pending.group) && SEVERING.has(pending.op),
        // `logs` never confirms (no prompt, never severing), so the label indexes safely past it.
        label: VERB_LABEL[pending.op as Exclude<SandboxVerb, `logs`>],
        destructive: pending.op === `remove`,
    };
});
const confirmAct = (): void => {
    const pending = confirmingAct.value;
    confirmingAct.value = undefined;
    if (pending !== undefined) {
        void runAct(pending.computer, pending.group, pending.op);
    }
};

const act = (computer: Computer, group: MachineSandboxGroup, op: SandboxVerb): void => {
    if (computer.hostId === undefined || group.sandbox === undefined || busy.value !== undefined) {
        return;
    }
    // The log button is a toggle: a pane the reader opened is theirs to close, and re-reading is the same click
    // again rather than a second control beside it.
    if (op === `logs` && openLog.value === rowKey(computer, group)) {
        openLog.value = undefined;
        // The result line goes with the pane it described. Left behind, `The last 200 lines from "…"` floats
        // under a row with no lines anywhere near it, which reads as something the view failed to finish.
        actionDone.value = undefined;
        return;
    }
    if (sandboxVerbPrompt(op, group.title) !== undefined || (isSelf(computer, group) && SEVERING.has(op))) {
        confirmingAct.value = { computer, group, op };
        return;
    }
    void runAct(computer, group, op);
};

const runAct = async (computer: Computer, group: MachineSandboxGroup, op: SandboxVerb): Promise<void> => {
    if (computer.hostId === undefined || group.sandbox === undefined || busy.value !== undefined) {
        return;
    }
    const key = rowKey(computer, group);
    const slug = group.sandbox.slug;
    busy.value = `${key}:${op}`;
    actionError.value = undefined;
    actionDone.value = undefined;
    runLines.value = { ...runLines.value, [key]: [] };
    // Opened before the lines arrive, so an empty pane says "reading" rather than the row looking like it ignored
    // the click. Every other op's pane closes when it ends; this one is the answer.
    openLog.value = op === `logs` ? key : undefined;
    try {
        const message = await manageMachineSandbox(computer.hostId, slug, op, {
            onLine: (line) => (runLines.value = { ...runLines.value, [key]: [...(runLines.value[key] ?? []), line] }),
        });
        // A log tail's own result line only restates what the pane above it already is ("the last 200 lines
        // from X"), so the pane is left to be the answer. Every other op ends with something worth reading.
        actionDone.value = op === `logs` ? undefined : { key, message };
    } catch (failure) {
        actionError.value = { key, notice: noticeFrom(failure, `That didn't work on this computer.`) };
        if (op === `logs`) {
            openLog.value = undefined;
        }
    } finally {
        busy.value = undefined;
        // Always, including after a failure: a flow that stopped halfway still changed the machine, and the row
        // must describe what is there now rather than what was there when it started. A log tail changed nothing,
        // so it costs the list nothing either.
        if (op !== `logs`) {
            refetch();
        }
    }
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <RowGroup label="Computers" :count="sorted.length === 0 ? undefined : sorted.length">
            <!-- The other half of the cross-link the Ports tab now carries. Both tabs are about "ports" and they
                 mean opposite directions: out to the internet there, in to the machine on your desk here, so
                 each says which it is rather than leaving the index's two similar words to be told apart by
                 opening both. -->
            <template #info>
                <InfoHint label="Computers">
                    <span class="block text-sm font-medium text-content">Your own machines</span>
                    <span class="mt-1 block text-xs text-muted">
                        Every computer paired with this sandbox: the folder it syncs, the ports it mirrors to your <b>localhost</b>, and the sandboxes
                        running on it.
                    </span>
                    <span class="mt-2 block text-xs text-muted">
                        A port that couldn't be mirrored shows under the sandbox that claimed it first. To expose a port to the public internet, use
                        the
                        <b>Ports</b> tab.
                    </span>
                </InfoHint>
            </template>
            <!-- READ INSIDE THE DESKTOP APP, this is one of two screens showing the same machines, and the
                 app's own is the one that needs no capability at all, because it runs ON the computer it
                 manages. Said once rather than per row: nothing here knows which of these machines the reader
                 is actually sitting at. -->
            <RowNote v-if="inDesktopApp" icon="desktop">
                This computer's own sandboxes are also in <b>This computer</b>, from the Intentic icon in your tray.
            </RowNote>
            <!-- IS ANYTHING WRONG RIGHT NOW: answered before a single row is parsed, which is what this view
                 had no way of saying. One measure split by state; the machine count is the group's own label. -->
            <template #actions>
                <StatusTally v-if="!isLoading && sorted.length > 0" :items="tally" />
            </template>
            <!-- Only once there is something to hunt through. Ports are matched too, because "which machine has
                 8788" is the question this tab is opened for and it used to be answerable only by reading. -->
            <RowNote v-if="!isLoading && showFilter" variant="block">
                <SearchBar
                    v-model="query"
                    variant="field"
                    placeholder="Filter by computer, sandbox, folder or port"
                    aria-label="Filter computers"
                    :clearable="true"
                />
            </RowNote>
            <Notice v-if="computersNotice" :of="computersNotice" class="m-4" />
            <div v-else-if="isLoading" role="status" aria-busy="true">
                <template v-if="outline">
                    <span class="sr-only">Reading your computers…</span>
                    <SkeletonRows :rows="2" description />
                </template>
            </div>
            <RowNote v-else-if="sorted.length === 0" variant="empty">
                No computer is paired with this sandbox yet. Enable desktop sync below to work on it from your own editor, or add a Linux/Windows PC
                from Capabilities to let the agent work there.
            </RowNote>
            <!-- ONE GUTTER PER COMPUTER. The mark sits in a column of its own and everything else: the name,
                 the facts, the machine's whole sandbox list: starts at the same x beside it, so three computers
                 read as three entries rather than as nine indents. That column is the machine's and only the
                 machine's, which is what lets the rail below run down it: nothing at any other tier is ever
                 drawn there, so the left edge of this list enumerates the COMPUTERS and nothing else. -->
            <div v-for="row in shown" :key="row.computer.key">
                <!-- WHO THIS IS, AND WHETHER ANYTHING UNDER IT WANTS YOU: the whole of a machine until it is
                     asked for. An offline computer used to cost a full block, a gutter and a 14px name to say
                     nothing was there; three of them pushed the machine you came for off the screen.
                     The name and the chevron are one hit area, so the disclosure is the row rather than a 12px
                     glyph beside it. A machine with no report never expands: there is nothing behind it. -->
                <component
                    :is="expandable(row) ? `button` : `div`"
                    :type="expandable(row) ? `button` : undefined"
                    :aria-expanded="expandable(row) ? machineOpen(row) : undefined"
                    class="flex w-full items-center gap-2.5 px-4 py-3 text-left"
                    :class="expandable(row) ? `group/machine cursor-pointer` : ``"
                    @click="expandable(row) ? toggleMachine(row) : undefined"
                >
                    <Icon
                        v-if="expandable(row)"
                        name="chevron-right"
                        class="shrink-0 text-2xs text-subtle transition-transform group-hover/machine:text-muted"
                        :class="machineOpen(row) ? `rotate-90` : undefined"
                        aria-hidden="true"
                    />
                    <!-- The glyph keeps the chevron's column on a row that has no chevron, so a list of live and
                         offline machines reads down one edge rather than two. -->
                    <span v-else class="w-[0.6rem] shrink-0"></span>
                    <!-- THE MARK OF A COMPUTER, IN A WELL OF ITS OWN, and it is the tier's own badge rather than
                         decoration: a sandbox row under it is marked by a 6px dot, so the two can no longer be
                         told apart only by a name two pixels larger. It also gives the rail below a column to
                         hang in, which is the whole of the alignment. -->
                    <span class="flex size-5 shrink-0 items-center justify-center rounded-md bg-content/10 text-content">
                        <Icon name="desktop" class="text-xs" />
                    </span>
                    <span class="min-w-0 truncate text-sm font-semibold text-content">{{ row.computer.label }}</span>
                    <!-- WHICH COMPUTER THIS IS. Beside the name rather than down in the detail line because it
                         is the fact that tells two rows apart at a glance, and the one the rows were missing:
                         three machines used to differ only by the word somebody typed when they added them:
                         and two of them can genuinely carry the same name. -->
                    <span v-if="osLabel(row.computer)" class="shrink-0 truncate text-xs text-muted" :title="osTitle(row.computer)">
                        {{ osLabel(row.computer) }}
                    </span>
                    <!-- WHAT THE FOLDED LINE STILL ANSWERS: how much is under here, and whether any of it wants
                         something. Hidden while the machine is open, where every row states its own. -->
                    <span v-if="!machineOpen(row)" class="ml-auto flex min-w-0 shrink items-center gap-x-2 pl-2">
                        <span v-for="fact in row.facts" :key="fact" class="shrink-0 text-2xs text-subtle">{{ fact }}</span>
                        <span v-for="warning in row.warnings" :key="warning" class="truncate text-2xs text-warning">{{ warning }}</span>
                        <span v-if="lastSeenNote(row.computer)" class="shrink-0 text-2xs text-subtle">{{ lastSeenNote(row.computer) }}</span>
                    </span>
                    <StatusBadge
                        :variant="tone(row.computer)"
                        size="xs"
                        :dot="true"
                        :label="label(row.computer)"
                        class="shrink-0"
                        :class="machineOpen(row) ? `ml-auto` : ``"
                    />
                </component>

                <!-- Everything else about this machine, HANGING OFF ITS MARK rather than indented under its name.
                     The rail is the same one the Plan limits panel draws under a provider, for the same reason:
                     this list nests three tiers deep (computer, sandbox, the sandbox's own facts) and had one
                     stroke for all of them, so an expanded machine's contents ran to the bottom of the card with
                     nothing saying where its territory ended. The line under the mark says exactly that, and it
                     is the only thing on this column, so reading down the left edge gives you the COMPUTERS. -->
                <div v-if="machineOpen(row) || !expandable(row)" class="flex gap-2.5 px-4 pb-4">
                    <span class="w-[0.6rem] shrink-0" aria-hidden="true"></span>
                    <!-- Pulled up into the header's own bottom padding so the line starts at the mark rather
                         than a row below it. -->
                    <span class="-mt-2 flex w-5 shrink-0 justify-center" aria-hidden="true"><span class="w-px bg-line-strong"></span></span>
                    <div class="flex min-w-0 flex-1 flex-col gap-3">
                        <!-- WHAT IT IS AND HOW THIS SANDBOX REACHES IT, on one line. Two facts of two kinds, so the
                         doors keep a shape of their own: they are the difference between a machine that syncs
                         your files and one the agent can run commands on, and a reader scanning three computers
                         is usually looking for exactly that.
                         A newer release rides INSIDE the tag it is about, right after the version it supersedes,
                         rather than at the end of a line the reader would have to match back up to a door. -->
                        <div
                            v-if="machineFacts(row.computer).length > 0 || computerDoors(row.computer, latest).length > 0"
                            class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5"
                        >
                            <p v-if="machineFacts(row.computer).length > 0" class="min-w-0 truncate text-xs text-muted">
                                {{ machineFacts(row.computer).join(` · `) }}
                            </p>
                            <span v-for="door in computerDoors(row.computer, latest)" :key="door.name" :class="DOOR">
                                <Icon :name="door.name === `desktop sync` ? `sync` : `terminal`" class="text-2xs text-subtle" />
                                {{ door.name }}
                                <span v-if="door.version" class="font-mono text-subtle">{{ door.version }}</span>
                                <span v-if="door.available" class="font-mono text-warning">{{ door.available }} available</span>
                            </span>
                        </div>

                        <!-- WHAT THE ROW WANTS FROM YOU, if anything: each on its own line, in the tone it earns. -->
                        <div
                            v-if="
                                syncAgentBehind(row.computer, latest) ||
                                (row.computer.report && reportStale(row.computer, now)) ||
                                row.computer.gap ||
                                blockText(row.computer)
                            "
                            class="flex flex-col gap-1"
                        >
                            <!-- An agent that has fallen behind is not an error: sync keeps working, so this is a
                             quiet line rather than a warning, and it names the one command that fixes it instead
                             of sending anyone to the browser for a pairing token. -->
                            <p v-if="syncAgentBehind(row.computer, latest)" class="text-xs text-subtle">
                                Run <span class="font-mono text-content">intentic-machine upgrade</span> on that computer to update its agent.
                            </p>
                            <!-- The reading's own age, not its arrival's: a report is a snapshot of a computer that
                             may since have closed its lid, so it is presented as of when the machine took it. -->
                            <p v-if="row.computer.report && reportStale(row.computer, now)" class="text-xs text-warning">
                                Last heard from {{ timeAgo(row.computer.report.capturedAt) }}. What follows is what it looked like then.
                            </p>
                            <p v-if="row.computer.gap" class="text-xs text-muted">{{ GAP_TEXT[row.computer.gap] }}</p>
                            <!-- WHY THE SANDBOX LIST BELOW HAS NO BUTTONS, and the one click that changes it. Quiet
                             ink, because none of these is a fault: a machine syncing files perfectly is the row
                             this reaches most often, and the desktop app has managed its containers all along. -->
                            <div v-if="blockText(row.computer)" class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <p class="min-w-0 text-xs text-muted">{{ blockText(row.computer) }}</p>
                                <!-- The fix has an address, so this is a link wearing the button's clothes: hovering
                                 it says where it goes, and Ctrl/⌘-click opens the card without losing the list
                                 of machines it was read from. -->
                                <Button
                                    v-if="blockAction(row.computer)"
                                    :as="RouterLink"
                                    :to="fixAt(row.computer)"
                                    size="small"
                                    severity="secondary"
                                    :text="true"
                                    :label="blockAction(row.computer)"
                                >
                                    <template #icon><Icon name="arrow-up-right" /></template>
                                </Button>
                            </div>
                        </div>

                        <!-- WHAT IT IS RUNNING FOR YOU: one row per sandbox, folded to a line that says whether it
                         is fine, and carrying its folder, its ports, its image and its verbs when opened. Only
                         a machine that reported can say any of it. -->
                        <div v-if="row.computer.report" class="border-t border-line-subtle pt-3">
                            <MachineDetail
                                :pairings="row.computer.report.pairings"
                                :ports="row.computer.report.ports"
                                :sandboxes="row.computer.report.sandboxes"
                                :watcher="row.watcher"
                                :open="row.open"
                                :undivided="true"
                            >
                                <!-- What the list is, and the state of the agent behind it, on one line: the
                                 watcher is a fact about the MACHINE rather than about any row under it. -->
                                <template #heading><span :class="SUBHEAD">Sandboxes on this computer</span></template>
                                <!-- The one row on this page that can close the page. Said beside the name rather
                                 than in the confirmation alone, so it is known before anything is clicked. -->
                                <template #badges="{ group }">
                                    <StatusBadge v-if="isSelf(row.computer, group)" variant="info" size="xs" label="the one you're using" />
                                </template>
                                <!-- The verbs themselves are the kit's, so this tab and the desktop app's manager
                                 window offer the same row rather than two sets that drifted. What stays here is
                                 which rows may act at all, and what a click does. -->
                                <template #actions="{ group }">
                                    <SandboxVerbs
                                        v-if="manageable(row.computer, group)"
                                        :running="group.sandbox?.running === true"
                                        :busy="runningVerb(row.computer, group)"
                                        :disabled="busy !== undefined"
                                        :logs-open="logShown(row.computer, group)"
                                        @act="(verb) => act(row.computer, group, verb)"
                                    />
                                </template>
                                <!-- The machine's own output: while a row works, and afterwards for as long as a log
                                 tail is being read. Every other operation has said all it had to say in its
                                 result line by the time it ends. -->
                                <template #footer="{ group }">
                                    <MachineRunLog
                                        v-if="busy?.startsWith(`${rowKey(row.computer, group)}:`) || logShown(row.computer, group)"
                                        :lines="runLines[rowKey(row.computer, group)] ?? []"
                                        :running="busy?.startsWith(`${rowKey(row.computer, group)}:`) === true"
                                        empty="Starting on that computer…"
                                        note="Running on that computer. It keeps going even if you leave this page."
                                    />
                                    <Notice v-if="actionError?.key === rowKey(row.computer, group)" :of="actionError.notice" />
                                    <p v-else-if="actionDone?.key === rowKey(row.computer, group)" class="text-xs text-muted">
                                        {{ actionDone.message }}
                                    </p>
                                </template>
                            </MachineDetail>
                        </div>

                        <!-- WHAT THIS SANDBOX KEEPS HERE, as opposed to what the person does: the runners it can
                         hand a conversation to, with the buttons that make and unmake one. Outside the report
                         gate above, deliberately, a machine that never reported still holds runners this
                         sandbox created, and the list of them is this side's own knowledge. -->
                        <MachineRunners :computer="row.computer" />
                    </div>
                </div>
            </div>
            <!-- A filter that matched nothing says so where the rows would have been, rather than leaving a
                 group that looks like it has lost its contents. -->
            <RowNote v-if="shown.length === 0 && sorted.length > 0" variant="empty"> No computer or sandbox here matches "{{ query }}". </RowNote>
        </RowGroup>

        <DesktopSyncCard :highlight="highlight" />
        <BridgeTokensCard />

        <!-- Red only for removal: the swaps commit the sandbox to another image and keep its files, and a
             danger button on those would say "this deletes something", which is the one thing they do not. -->
        <ConfirmDialog
            :open="confirmingAct !== undefined"
            :header="actPrompt?.header ?? ``"
            :confirm-label="actPrompt?.label ?? `Continue`"
            :destructive="actPrompt?.destructive === true"
            @cancel="confirmingAct = undefined"
            @confirm="confirmAct"
        >
            <p v-if="actPrompt?.body !== undefined">{{ actPrompt.body }}</p>
            <p v-if="actPrompt?.severing === true" class="mt-3 text-xs text-warning">
                This is the sandbox you are using right now — this page will lose it.
            </p>
        </ConfirmDialog>
    </div>
</template>
