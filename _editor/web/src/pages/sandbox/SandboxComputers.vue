<script setup lang="ts">
import {
    type Computer,
    type MachineCommand,
    type MachineSandboxOp,
    type MachineWatcher,
    watcherBuildSkew,
    watcherStalled,
} from "@intentic/sandbox-contract";
import {
    Button,
    ConfirmDialog,
    DisclosureRow,
    groupNeedsAttention,
    InfoHint,
    MachineDetail,
    type MachineFolderRow,
    MachineRunLog,
    type MachineSandboxGroup,
    mirroringOff,
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
    computerSummary,
    lastSeenNote,
    machineFacts,
    type ManageBlock,
    manageBlock,
    osLabel,
    osTitle,
    syncAgentBehind,
    syncNote,
    syncStopped,
} from "./computerFacts";
import DesktopSyncCard from "./DesktopSyncCard.vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { manageMachineSandbox, reportStale, revokeSyncMachine, runMachineCommand, useComputers } from "../../composables/sandbox/useComputers";
import { useRole } from "../../composables/sandbox/useRole";
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
 * DESKTOP SYNC IS A PROPERTY OF A COMPUTER, NOT OF THE SANDBOX, and that is the last thing this page had wrong.
 * A card under the list held the whole subject: one "Syncing from radarsu-rog", one folder path, one "Disable
 * sync" that revoked EVERY paired computer at once. The store underneath was never shaped like that — it is a
 * list of machines, each holding either full sync or ports-only, each with its own folder, its own mirrored
 * ports and its own heartbeat — and the machine agent has been per-computer and per-sandbox all along
 * (`intentic-machine sync pause --sandbox …`). So a reader saw one sandbox-level claim above a list of the
 * several computers that actually disagreed with it, and the only revoke they could reach was the fleet's.
 *
 * Every one of those facts is now on the row of the machine it belongs to (`ComputerSync`, syncNote), and every
 * switch beside the thing it changes: pause and unpair under the FOLDER, mirroring under the PORTS, revoke on
 * the machine. What survives below is the pairing card, which does the one job that genuinely belongs to the
 * sandbox: handing out the one-liner that adds a computer.
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
    offline: `Asleep or offline.`,
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
    readonly watcher:
        | (MachineWatcher & { readonly stalled: boolean; readonly staleBuild?: { running: string | undefined; installed: string } })
        | undefined;
}

/* WHICH ROW IS THE SANDBOX YOU ARE LOOKING AT. The container's slug on its machine is the leading label of the
 * daemon's own hostname: the same derivation the sandbox switcher uses for its teardown command, and the same
 * one the setup CLI applies when it names the container.
 *
 * It matters because this view can stop and delete the very sandbox serving it. That is a legitimate thing to
 * want and a terrible thing to do by accident, so the row says so and the confirmation names it. */
const { daemonUrl } = useSandbox();
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));
/* BOTH SIDES HAVE TO BE KNOWN. `group.sandbox?.slug === ownSlug.value` compared two optionals, so a pairing with
 * no container on a page whose daemon URL is unknown (a loopback or dev sandbox) matched `undefined ===
 * undefined` and every such row claimed to be the sandbox you are reading this in: badged "the one you're
 * using", unfolded on arrival, and named in the severing warning of any confirmation aimed at it. */
const isSelf = (computer: Computer, group: MachineSandboxGroup): boolean =>
    computer.hostId !== undefined && ownSlug.value !== undefined && group.sandbox?.slug === ownSlug.value;

// What the reader typed. Lower-cased once here rather than per comparison, and blank until they type: an empty
// filter must never narrow anything.
const query = ref(``);
const needle = computed(() => query.value.trim().toLowerCase());

const rows = computed<ComputerRow[]>(() =>
    sorted.value.map((computer) => {
        const groups = machineGroups(computer);
        const { facts, warnings } = computerSummary(computer, groups, now.value);
        const watcher = computer.report?.watcher;
        /* Whether this machine is serving an older agent than the one installed on it — the same comparison the
         * terminal makes (watcherBuildSkew), carried onto the watcher so <MachineDetail> can say it beside the
         * pid. A machine that has never reported has no watcher and nothing to compare. */
        const staleBuild = computer.report === undefined ? undefined : watcherBuildSkew(computer.report);
        return {
            computer,
            groups,
            facts,
            warnings,
            open: groups
                .filter((group) => isSelf(computer, group) || (needle.value !== `` && groupMatches(group, needle.value)))
                .map((group) => group.sandboxId),
            watcher:
                watcher === undefined
                    ? undefined
                    : { ...watcher, stalled: watcherStalled(watcher, now.value), ...(staleBuild === undefined ? {} : { staleBuild }) },
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
    /* THE SENTENCE THIS PAGE WAS MISSING. Every button below hangs on a socket this computer opens outbound, and
     * a machine can be syncing files flawlessly with that socket down: the sync half and the computer half are
     * two doors, and only one of them is open here. It names the command rather than offering a control, like
     * the agent-behind line above it, because the remedy is on that computer and nothing here can press it. */
    offline: `This computer is connected but isn't reachable right now — asleep, off the network, or its agent isn't running — so its sandboxes can't be started, updated or removed from here.`,
    "sandboxes-off": `Turn on "Manage sandboxes on this computer" in this computer's capability card to use the buttons below.`,
    "remove-off": `Removing a sandbox needs "Remove sandboxes from this computer" on this computer's capability card. Everything else below already works.`,
};
/* THE REMEDY THAT IS A COMMAND RATHER THAN A CONTROL, split out so it can be SET IN MONO like every other
 * command this view names. Inside the sentence above it was prose, and a bare `intentic-machine run` in the
 * middle of a grey paragraph is the one thing on this row nobody would recognise as something to type — while
 * the line directly above it renders the same shape of instruction in the app's own command ink. */
const BLOCK_COMMAND: Partial<Record<ManageBlock[`kind`], string>> = { offline: `intentic-machine run` };
// Only the kinds a click can actually close. An offline computer has no button here on purpose: its fix is a
// command on that machine, and a control pointing at a capability card would send the reader to the one place
// that cannot help.
const BLOCK_ACTION: Partial<Record<ManageBlock[`kind`], string>> = {
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
// The command to type on that computer, where the fix is one rather than a click.
const blockCommand = (computer: Computer): string | undefined => {
    const block = blockOf(computer);
    return block === undefined ? undefined : BLOCK_COMMAND[block.kind];
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
/* The pairing switches' own in-flight call, kept OUT of `busy` rather than folded into it. `busy` is
 * `${row}:${verb}`, and the row splits its own verb back out of it to decide which button spins
 * (`runningVerb`): a value in there that is not a container verb makes <SandboxVerbs> spin its ⋯ menu for
 * something that is not in the menu. Two refs, one meaning, read through `working`.
 *
 * It carries the COMMAND as well as the row, because there are three of these buttons on a row now (pause under
 * the folder, mirroring under the ports, and unpair beside the first). Keyed by row alone, pressing any one of
 * them spun all three, which reads as a page that did not understand the click. */
const syncBusy = ref<{ key: string; command: MachineCommand } | undefined>();
// Whether THIS row's THIS button is the one waiting on a machine. Pause and resume are one button wearing two
// labels, so they answer to each other: the label flips on the machine's next report, not on the click.
const PAIRED_WITH: Partial<Record<MachineCommand, MachineCommand>> = {
    "sync-pause": `sync-resume`,
    "sync-resume": `sync-pause`,
    "mirror-off": `mirror-on`,
    "mirror-on": `mirror-off`,
};
const syncRunning = (computer: Computer, group: MachineSandboxGroup, command: MachineCommand): boolean =>
    syncBusy.value?.key === rowKey(computer, group) && (syncBusy.value.command === command || syncBusy.value.command === PAIRED_WITH[command]);
// Something is running on some machine. Every button on this tab drives one socket per computer, and the tab
// has always taken the simple rule: one at a time, everything else waits. A mirroring switch and a container
// verb racing on the same pairing would be two answers about the same ports.
const working = computed(() => busy.value !== undefined || syncBusy.value !== undefined);
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
    if (computer.hostId === undefined || group.sandbox === undefined || working.value) {
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
    if (computer.hostId === undefined || group.sandbox === undefined || working.value) {
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

/* --- WHAT THIS COMPUTER IS DOING FOR THIS SANDBOX, AND HOW TO CHANGE IT ------------------------------------
 *
 * The controls on this tab that change the COMPUTER rather than a container on it. There are three, and they
 * are the two halves of one pairing plus its end: file syncing (pause/resume), port mirroring (off/on), and
 * unpairing, which stops both.
 *
 * Mirroring is the half that writes to somebody's own localhost: a sandbox's dev server takes localhost:5173 on
 * their desk, where their own was going to go. File syncing is the half that writes to their FILES, which is the
 * more intrusive of the two and, until now, the one with no button: it had a CLI and a paragraph telling the
 * reader to go and find a terminal, on the very view built to replace that terminal. "Not on my localhost today"
 * and "stop touching my files for an hour" are the same size of ask and now cost the same click.
 *
 * THE MACHINE OWNS ALL THREE, and these buttons ask for them by running that machine's OWN CLI over the computer
 * connection (`intentic-machine sync mirror off`, `… sync pause`, `… sync uninstall`, each built daemon-side
 * from a name in a closed set). So a button and a command are one gesture rather than two mechanisms that can
 * disagree, and a computer told to keep ports off keeps them off while this sandbox is asleep, unreachable, or
 * arguing. It is also why unpairing goes through the machine rather than through this side's own revoke: the
 * agent terminates its Mutagen sessions, drops its local pairing and self-revokes on the way out, where a
 * sandbox-side revoke would leave the machine to discover its key had stopped working.
 *
 * WHERE THEY CAN BE OFFERED: the computer door (`hostId`), the machine awake, and no `gap` in the way, which is
 * where "Run commands is off" already lands and is stated in the row's own line above. A pairing is required
 * too: all three belong to one, and a container this sandbox never paired with has nothing of ours on it. */
const commandable = (computer: Computer, group: MachineSandboxGroup): boolean =>
    computer.hostId !== undefined && computer.online === true && computer.gap === undefined && group.folder !== undefined;

/* Pause and resume are FILE SYNC's, so they are offered only where there is a file sync: a mirror enrollment has
 * no Mutagen session to pause, and the machine's own CLI says exactly that if asked ("mirror-only enrollment, no
 * file sync to pause"). Better not to draw the button than to draw one whose answer is that sentence. */
const pausable = (computer: Computer, group: MachineSandboxGroup): boolean => commandable(computer, group) && group.folder?.mode === `sync`;

// What each command is called on the row, and what to say if the machine would not do it. Kept beside each other
// rather than inlined at three call sites so a verb and its failure sentence cannot drift apart.
const COMMAND_REFUSAL: Record<MachineCommand, string> = {
    "mirror-off": `That computer didn't change its port mirroring.`,
    "mirror-on": `That computer didn't change its port mirroring.`,
    "sync-pause": `That computer didn't pause its file syncing.`,
    "sync-resume": `That computer didn't resume its file syncing.`,
    "sync-unpair": `That computer didn't unpair this sandbox.`,
};
const COMMAND_UNREACHED: Record<MachineCommand, string> = {
    "mirror-off": `Couldn't reach that computer to change its port mirroring.`,
    "mirror-on": `Couldn't reach that computer to change its port mirroring.`,
    "sync-pause": `Couldn't reach that computer to pause its file syncing.`,
    "sync-resume": `Couldn't reach that computer to resume its file syncing.`,
    "sync-unpair": `Couldn't reach that computer to unpair this sandbox.`,
};

/* No confirmation for the reversible four, deliberately: each takes something off a machine and puts it back,
 * destroys nothing, and the button that undoes it is the one that appears in its place. `sync-unpair` ends a
 * pairing that only a fresh one-liner re-makes, so the template routes that one through the dialog first.
 *
 * `sandboxId` is what makes this both switches at once. With one, it is the pairing's own button and the CLI acts
 * on that pairing alone — a button on one row must never reach across to a colleague's pairing on the same
 * laptop. WITHOUT one it is the MACHINE's button, and the bare CLI form does exactly what it does in a terminal:
 * every sandbox this computer pairs. That is the "turn it off on this machine" the row is for, and the reason the
 * two are one function is that they are one command with one argument's difference. */
const runSync = async (computer: Computer, key: string, sandboxId: string | undefined, command: MachineCommand): Promise<void> => {
    if (computer.hostId === undefined || working.value) {
        return;
    }
    syncBusy.value = { key, command };
    actionError.value = undefined;
    actionDone.value = undefined;
    try {
        const result = await runMachineCommand(computer.hostId, command, sandboxId);
        /* THE MACHINE'S OWN SENTENCE, either way. It names the ports it actually took off localhost, or the
         * sessions it paused, which is more than this side knows, and a refusal names the switch to flip.
         * `ok: false` is a real answer rather than a throw (see runMachineCommand), so it is shown as the machine
         * explaining itself: amber, because nothing here broke, the computer simply did not do it. */
        actionDone.value = result.ok ? { key, message: result.message } : undefined;
        actionError.value = result.ok ? undefined : { key, notice: { tone: `warning`, title: COMMAND_REFUSAL[command], detail: result.message } };
    } catch (failure) {
        actionError.value = { key, notice: noticeFrom(failure, COMMAND_UNREACHED[command]) };
    } finally {
        syncBusy.value = undefined;
        /* The ports on this row are exactly what just changed, and the daemon dropped its cached reading of this
         * machine as the command ran, so this re-read blocks on a real answer rather than serving the list from
         * before the click. Always, including after a failure: a call that timed out from here still ran there. */
        refetch();
    }
};

/* --- THE TWO HALVES, SWITCHED FOR THE WHOLE COMPUTER ------------------------------------------------------
 *
 * The same two commands as the per-pairing buttons below, run bare: `intentic-machine sync pause` and
 * `… sync mirror off` with no `--sandbox` act on every sandbox that computer pairs, which is precisely what
 * they mean in a terminal and precisely what "turn this off on this machine" should mean here.
 *
 * WHY BOTH SCOPES EXIST. A pairing's own switch answers "not this project on my localhost today". A machine's
 * answers "I'm working on something else on this laptop" — and it is the one somebody actually reaches for,
 * because a computer running four sandboxes otherwise costs four clicks in four unfolded rows to say one thing.
 * The pairing buttons stay for the times the finer answer is the right one.
 *
 * A MACHINE CAN BE IN NEITHER STATE, which is not a wrinkle to hide: those per-pairing switches are exactly what
 * produces a laptop mirroring one sandbox and not another. So the switch is three-valued, the row says which
 * pairings disagree, and in that state it offers BOTH directions rather than guessing which way "the" switch
 * was meant to point. */
type HalfState = `on` | `off` | `mixed`;
interface MachineHalf {
    readonly state: HalfState;
    /** How many of this machine's pairings are in the minority, for the sentence that explains a mixed row. */
    readonly off: number;
    readonly total: number;
}

// Absent `mirroring` reads as ON, which is what mirroring has always been and what every agent older than the
// switch reports (the same rule mirroringOff states from the kit's side).
const halfOf = (pairings: readonly (MachineFolderRow | undefined)[], isOff: (folder: MachineFolderRow) => boolean): MachineHalf => {
    const held = pairings.filter((folder): folder is MachineFolderRow => folder !== undefined);
    const off = held.filter((folder) => isOff(folder)).length;
    const state: HalfState = off === 0 ? `on` : off === held.length ? `off` : `mixed`;
    return { state, off, total: held.length };
};

// File syncing is only a question where there IS one: a mirror enrollment has no Mutagen session to pause, so
// its pairings are not counted either way. A machine holding only mirrors draws no file-sync switch at all.
const syncHalf = (row: ComputerRow): MachineHalf =>
    halfOf(
        row.groups.map((group) => group.folder).filter((folder) => folder?.mode === `sync`),
        (folder) => folder.paused === true,
    );
const mirrorHalf = (row: ComputerRow): MachineHalf => halfOf(
    row.groups.map((group) => group.folder),
    mirroringOff,
);

/* WHERE THE MACHINE'S OWN SWITCHES CAN BE OFFERED: the same three conditions the per-pairing ones take (the
 * computer door, the machine awake, no `gap`), plus at least one pairing for the half in question. A computer
 * with nothing paired has nothing to switch, and a row that drew the control anyway would be asking the machine
 * a question about a sandbox it has never heard of. */
const switchable = (row: ComputerRow, half: MachineHalf): boolean =>
    row.computer.hostId !== undefined && row.computer.online === true && row.computer.gap === undefined && half.total > 0;

// The machine's own busy key. `rowKey` is `${computer.key}:${sandboxId}`, so a bare computer key cannot collide
// with any pairing's, and the two scopes' spinners stay apart.
const machineKey = (computer: Computer): string => computer.key;

/* WHAT A MIXED HALF SAYS, in the machine's own units. "2 of 3 paused" is the whole explanation for why this row
 * offers two buttons where every other switch in this view offers one. */
const halfNote = (half: MachineHalf, offWord: string): string | undefined =>
    half.state === `mixed` ? `${half.off} of ${half.total} ${offWord}` : undefined;

/* THE ROW'S TWO SWITCHES, DERIVED ONCE. Both halves are the same shape of thing — a state, a word for it, and
 * the one or two commands that would change it — so they are one table rather than two near-identical blocks of
 * template, and the words each half uses live beside the state they describe.
 *
 * WHICH BUTTONS: one, pointing wherever the machine currently is not, except in the mixed state, where the
 * honest answer is both. A single button there would have to pick a direction for a reader who has deliberately
 * set two pairings differently, and whichever it picked would silently undo half of what they had arranged. */
interface HalfAction {
    readonly command: MachineCommand;
    readonly label: string;
    readonly hint: string;
}
interface MachineSwitch {
    readonly label: string;
    readonly state: HalfState;
    /** The state in one word, for the settled positions. */
    readonly word: string;
    /** What disagrees, when the pairings do. Replaces the word rather than joining it. */
    readonly note: string | undefined;
    readonly actions: readonly HalfAction[];
}

const PAUSE: HalfAction = {
    command: `sync-pause`,
    label: `Pause all`,
    hint: `Stop moving files either way, for every sandbox this computer syncs. Their ports keep being mirrored.`,
};
const RESUME: HalfAction = { command: `sync-resume`, label: `Resume all`, hint: `Start moving files again for every sandbox this computer syncs.` };
const MIRROR_OFF: HalfAction = {
    command: `mirror-off`,
    label: `Stop all`,
    hint: `Take every paired sandbox's ports off this computer's localhost. Files keep syncing.`,
};
const MIRROR_ON: HalfAction = { command: `mirror-on`, label: `Start all`, hint: `Put every paired sandbox's ports back on this computer's localhost.` };

// The one/one/both rule, stated once for both halves: a settled switch offers the way out of where it is, and a
// mixed one offers both ways rather than choosing for somebody who has already chosen per pairing.
const actionsFor = (state: HalfState, off: HalfAction, on: HalfAction): HalfAction[] =>
    state === `on` ? [off] : state === `off` ? [on] : [on, off];

const machineSwitches = (row: ComputerRow): MachineSwitch[] => {
    const switches: MachineSwitch[] = [];
    const sync = syncHalf(row);
    if (switchable(row, sync)) {
        switches.push({
            label: `File syncing`,
            state: sync.state,
            word: sync.state === `off` ? `paused` : `on`,
            note: halfNote(sync, `paused`),
            actions: actionsFor(sync.state, PAUSE, RESUME),
        });
    }
    const mirror = mirrorHalf(row);
    if (switchable(row, mirror)) {
        switches.push({
            label: `Port mirroring`,
            state: mirror.state,
            word: mirror.state === `off` ? `off` : `on`,
            note: halfNote(mirror, `off`),
            actions: actionsFor(mirror.state, MIRROR_OFF, MIRROR_ON),
        });
    }
    return switches;
};

/* UNPAIRING IS THE ONE THAT DOES NOT UNDO ITSELF: the machine terminates its sessions, drops its pairing and
 * self-revokes, and turning it back on means a fresh one-liner over there. So it parks in the app's own dialog
 * rather than the browser's confirm(), like the container verbs above it. */
const confirmingUnpair = ref<{ computer: Computer; group: MachineSandboxGroup } | undefined>();
const confirmUnpair = (): void => {
    const pending = confirmingUnpair.value;
    confirmingUnpair.value = undefined;
    if (pending !== undefined) {
        void runSync(pending.computer, rowKey(pending.computer, pending.group), pending.group.sandboxId, `sync-unpair`);
    }
};

/* --- CUTTING A COMPUTER OFF FROM THIS SANDBOX -------------------------------------------------------------
 *
 * The other kind of ending, and the difference from Unpair above is which side is holding the machine. Unpair
 * ASKS the computer to clean up after itself, which is better whenever it can be asked. This one drops the key
 * from the sandbox and lets the machine find out, which is the only thing that works for a laptop that is lost,
 * wiped, permanently asleep, or somebody else's.
 *
 * PER MACHINE, which is the whole change: the only revoke a browser could reach used to clear every enrollment
 * at once, because it lived on a card that treated desktop sync as one property of the sandbox. There is no
 * fleet-wide button behind this on purpose — three computers is three deliberate acts, each on the row that
 * describes it.
 *
 * Owner-only, matching the daemon's own floor and the hosts revoke beside it: a member holds their own mirror
 * enrollment and drops it from their own machine, but ending somebody else's is the owner's call. */
const { isOwner } = useRole();
const confirmingRevoke = ref<Computer | undefined>();
const revoking = ref(false);
const runRevoke = async (): Promise<void> => {
    const computer = confirmingRevoke.value;
    /* The row lost its enrollment between opening this dialog and confirming it: the list re-reads every ten
     * seconds, and the machine may have uninstalled itself in between. There is nothing left to revoke, so the
     * dialog closes rather than sitting open over a question that has answered itself. */
    if (computer?.sync === undefined) {
        confirmingRevoke.value = undefined;
        return;
    }
    revoking.value = true;
    actionError.value = undefined;
    actionDone.value = undefined;
    try {
        await revokeSyncMachine(computer.sync.machine);
        confirmingRevoke.value = undefined;
        actionDone.value = { key: computer.key, message: `${computer.label} no longer has access to this sandbox.` };
    } catch (failure) {
        actionError.value = { key: computer.key, notice: noticeFrom(failure, `Couldn't revoke that computer's access.`) };
        confirmingRevoke.value = undefined;
    } finally {
        revoking.value = false;
        // The row it was aimed at is about to lose its enrollment, so the list has to be re-read either way: a
        // revoke that failed here may still have landed, and the machine is the only honest source for which.
        refetch();
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
            <!-- ONE COMPUTER, ONE ROW, AND IT IS THE APP'S ROW.
                 A MACHINE IS A LIST ROW; A SANDBOX UNDER IT IS A REPORT ENTRY. That is the whole of why the
                 wash lands on this tier and stops here. This row is one of a card's entries, the same as an
                 extension, a secret or a persona, so it opens the way those do; the rows inside it are a
                 <MachineDetail> report on an already-open row, and a second wash inside the first is one
                 tint on top of another rather than a second answer to "which of these did I open". See that
                 component, which states the same rule from its own side.

                 It was hand-rolled here until it was reported as exactly what it was — the one list in the
                 hub that stopped lighting up when you opened it. Rebuilt on <DisclosureRow>, that difference
                 goes, and four smaller ones with it: `px-4 py-3` against the tier's `px-4 py-2.5`, `gap-2.5`
                 against `gap-3`, a 20px mark against the list's 22, and an `aria-expanded` with no
                 `aria-controls` under it, which is a row that tells a screen reader it is open and never says
                 what it opened. A press that drags (selecting a path out of an open row) also stops closing
                 the row, because the component measures that and this file never did. -->
            <DisclosureRow
                v-for="row in shown"
                :key="row.computer.key"
                :open="expandable(row) ? machineOpen(row) : true"
                :disabled="!expandable(row)"
                @update:open="toggleMachine(row)"
            >
                <!-- THE MARK OF A COMPUTER, IN A WELL OF ITS OWN, and it is the tier's own badge rather than
                     decoration: a sandbox row under it is marked by a 6px dot, so the two can no longer be
                     told apart only by a name two pixels larger. Sized from the tier rather than typed, which
                     is the same rule the marks on every other list in the app now follow — this one said
                     `size-5` beside their 22 — and the offset the block below is railed at is measured off
                     this cluster rather than guessed at, so the two cannot drift apart. -->
                <template #lead="{ mark }">
                    <!-- A machine with no report never expands, and <DisclosureRow> drops the chevron on a row
                         with nothing behind it. This keeps that column, so a list of live and offline machines
                         still reads down one edge rather than two. -->
                    <span v-if="!expandable(row)" class="w-[0.6rem] shrink-0" aria-hidden="true"></span>
                    <span
                        class="flex shrink-0 items-center justify-center rounded-md bg-content/10 text-content"
                        :style="{ width: `${mark}px`, height: `${mark}px` }"
                    >
                        <Icon name="desktop" class="text-xs" />
                    </span>
                </template>

                <template #title>
                    <span class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                        <!-- Semibold against the tier's own medium: this row is the top of three nested tiers
                             and has to outrank the sandbox names inside it, which are a size down already. -->
                        <span class="min-w-0 truncate font-semibold">{{ row.computer.label }}</span>
                        <!-- WHICH COMPUTER THIS IS. Beside the name rather than down in the detail line because
                             it is the fact that tells two rows apart at a glance, and the one the rows were
                             missing: three machines used to differ only by the word somebody typed when they
                             added them: and two of them can genuinely carry the same name. -->
                        <span v-if="osLabel(row.computer)" class="shrink-0 truncate text-xs font-normal text-muted" :title="osTitle(row.computer)">
                            {{ osLabel(row.computer) }}
                        </span>
                        <span v-for="door in computerDoors(row.computer, latest)" :key="door.name" :class="DOOR">
                            <Icon name="sync" class="text-2xs text-subtle" />
                            {{ door.name }}
                            <span v-if="door.version" class="font-mono text-subtle">{{ door.version }}</span>
                            <span v-if="door.available" class="font-mono text-warning">{{ door.available }} available</span>
                        </span>
                    </span>
                </template>

                <!-- WHAT THE FOLDED LINE STILL ANSWERS: how much is under here, and whether any of it wants
                     something. Hidden while the machine is open, where every row states its own. Facts rather
                     than actions, badge included: a press on any of them opens the row like the rest of it,
                     which is what `#meta` means and what a hand-written `ml-auto` cluster had to be told. -->
                <template #meta>
                    <template v-if="!machineOpen(row)">
                        <span v-for="fact in row.facts" :key="fact" class="shrink-0">{{ fact }}</span>
                        <span v-for="warning in row.warnings" :key="warning" class="truncate text-warning">{{ warning }}</span>
                        <span v-if="lastSeenNote(row.computer)" class="shrink-0">{{ lastSeenNote(row.computer) }}</span>
                    </template>
                    <StatusBadge :variant="tone(row.computer)" size="xs" :dot="true" :label="label(row.computer)" class="shrink-0" />
                </template>

                <!-- Everything else about this machine, RAILED OFF ITS OWN HEADER rather than indented under
                     it. This list nests three tiers deep (computer, sandbox, the sandbox's own facts) and had
                     one stroke for all of them, so an expanded machine's contents ran to the bottom of the
                     card with nothing saying where its territory ended. The rail says exactly that, and it is
                     the component's rather than this file's: the indent is measured off the toggle cluster
                     above, so it cannot go stale the next time a mark or a chevron changes size. -->
                <template #below>
                    <div class="flex flex-col gap-3">
                        <p v-if="machineFacts(row.computer).length > 0" class="min-w-0 truncate text-xs text-muted">
                            {{ machineFacts(row.computer).join(` · `) }}
                        </p>

                        <!-- WHAT THIS COMPUTER'S ENROLLMENT IS, restated inside the open row. The folded line
                             carries it too, and hides it when the row opens (every other fact up there is
                             stated in full below), so without this the one thing the whole area is about
                             vanishes at exactly the moment somebody goes looking for it. Warning ink when the
                             machine has stopped checking in: nothing is reaching its folder, and that is the
                             failure this used to keep reading as healthy. -->
                        <p
                            v-if="syncNote(row.computer, now)"
                            class="min-w-0 text-xs"
                            :class="syncStopped(row.computer, now) ? `text-warning` : `text-muted`"
                        >
                            {{ syncNote(row.computer, now) }}
                        </p>

                        <!-- THE TWO HALVES, SWITCHED FOR THE WHOLE COMPUTER. The same two commands the pairing
                             rows below carry, run bare, which is what they mean in a terminal: every sandbox
                             this machine pairs. It is the switch somebody actually reaches for — "I'm working
                             on something else on this laptop" — where the per-pairing ones answer the finer
                             question, and a computer running four sandboxes should not cost four clicks in four
                             unfolded rows to say one thing.
                             Rendered as distinct compact control pairs with consistent secondary buttons. -->
                        <div v-if="switchable(row, syncHalf(row)) || switchable(row, mirrorHalf(row))" class="flex flex-col gap-2 rounded-lg bg-content/2 px-3 py-2 border border-line-subtle/50">
                            <div v-for="half in machineSwitches(row)" :key="half.label" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                                <div class="flex items-center gap-2">
                                    <span class="text-xs font-medium text-content">{{ half.label }}</span>
                                    <span class="inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium" :class="half.state === 'off' ? 'bg-content/5 text-subtle' : 'bg-success/10 text-success'">
                                        {{ half.note ?? half.word }}
                                    </span>
                                </div>
                                <div class="flex flex-wrap items-center gap-1.5">
                                    <Button
                                        v-for="action in half.actions"
                                        :key="action.command"
                                        size="small"
                                        severity="secondary"
                                        :label="action.label"
                                        :loading="syncBusy?.key === machineKey(row.computer) && syncBusy.command === action.command"
                                        :disabled="working"
                                        v-tooltip.top="action.hint"
                                        @click="void runSync(row.computer, machineKey(row.computer), undefined, action.command)"
                                    />
                                </div>
                            </div>
                            <!-- The machine's own answer to a machine-level click, where the click was. The
                                 pairing rows below have their own footer for theirs. -->
                            <Notice v-if="actionError?.key === machineKey(row.computer)" :of="actionError.notice" />
                            <p v-else-if="actionDone?.key === machineKey(row.computer)" class="text-xs text-muted">{{ actionDone.message }}</p>
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
                                <p class="min-w-0 text-xs text-muted">
                                    {{ blockText(row.computer) }}
                                    <!-- Set in the same command ink as the upgrade line above, and kept on one
                                         line: a command broken across a wrap is a command nobody can copy by
                                         eye, which is the only way this one is going to be read. -->
                                    <template v-if="blockCommand(row.computer)">
                                        Run <span class="font-mono whitespace-nowrap text-content">{{ blockCommand(row.computer) }}</span> on that
                                        computer.
                                    </template>
                                </p>
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
                                        :disabled="working"
                                        :logs-open="logShown(row.computer, group)"
                                        @act="(verb) => act(row.computer, group, verb)"
                                    />
                                </template>
                                <!-- WHAT TO DO ABOUT THIS PAIRING'S FILES, under the folder rather than up in the
                                 verbs, which act on the CONTAINER. A "Pause" beside the Stop that stops the
                                 sandbox would be read as the same act, and this one stops nothing in the
                                 sandbox: the box keeps running, the ports keep arriving, the files stop moving.
                                 Pause had no button at all until now — only a sentence naming a command to go
                                 and type, on the view built to replace that terminal. -->
                                 <template #folder="{ group }">
                                     <div class="mt-1 flex flex-wrap items-center gap-2">
                                         <Button
                                             v-if="pausable(row.computer, group)"
                                             size="small"
                                             severity="secondary"
                                             :label="group.folder?.paused === true ? `Resume syncing` : `Pause syncing`"
                                             :loading="syncRunning(row.computer, group, `sync-pause`)"
                                             :disabled="working"
                                             v-tooltip.top="
                                                 group.folder?.paused === true
                                                     ? `Start moving files between this computer and the sandbox again`
                                                     : `Stop moving files either way. The sandbox keeps running and its ports keep being mirrored.`
                                             "
                                             @click="
                                                 void runSync(
                                                     row.computer,
                                                     rowKey(row.computer, group),
                                                     group.sandboxId,
                                                     group.folder?.paused === true ? `sync-resume` : `sync-pause`,
                                                 )
                                             "
                                         />
                                         <!-- THE END OF THE PAIRING, and the one control here that nothing undoes in
                                          a click: turning it back on means a fresh one-liner on that computer. It
                                          asks the MACHINE to unpair (which is why it needs the computer door), so
                                          the agent tears its own sessions down and self-revokes rather than
                                          discovering later that its key stopped working. -->
                                         <Button
                                             v-if="commandable(row.computer, group)"
                                             size="small"
                                             severity="danger"
                                             :text="true"
                                             label="Unpair"
                                             :loading="syncRunning(row.computer, group, `sync-unpair`)"
                                             :disabled="working"
                                             v-tooltip.top="`Stop this computer syncing this sandbox. Its local folder is left exactly as it is.`"
                                             @click="confirmingUnpair = { computer: row.computer, group }"
                                         />
                                     </div>
                                 </template>
                                 <!-- THE SWITCH THAT CLEARS THE USER'S OWN LOCALHOST, under the ports it is about
                                  rather than up in the verbs, which act on the container. Two "Stop"s a pixel
                                  apart would be read as one, and this one stops nothing in the sandbox: the dev
                                  server keeps serving, the files keep syncing, the number leaves the machine's
                                  localhost. Its label points whichever way the machine currently says. -->
                                 <template #ports="{ group }">
                                     <div class="mt-1 flex flex-wrap items-center gap-2">
                                         <Button
                                             v-if="commandable(row.computer, group)"
                                             size="small"
                                             severity="secondary"
                                             :label="mirroringOff(group.folder) ? `Start mirroring` : `Stop mirroring`"
                                             :loading="syncRunning(row.computer, group, `mirror-off`)"
                                             :disabled="working"
                                             v-tooltip.top="
                                                 mirroringOff(group.folder)
                                                     ? `Put this sandbox's ports back on this computer's localhost`
                                                     : `Take this sandbox's ports off this computer's localhost. Files keep syncing.`
                                             "
                                             @click="
                                                 void runSync(
                                                     row.computer,
                                                     rowKey(row.computer, group),
                                                     group.sandboxId,
                                                     mirroringOff(group.folder) ? `mirror-on` : `mirror-off`,
                                                 )
                                             "
                                         />
                                     </div>
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

                        <!-- CUTTING THIS COMPUTER OFF, at the bottom of its own row, because it ends everything
                             above it at once. It is the machine-level twin of Unpair: that one asks the computer
                             to stop syncing ONE sandbox and needs the computer to be reachable, this one drops
                             the key here and works on a laptop that is lost, wiped or permanently asleep — which
                             is the case it exists for, and the case Unpair cannot serve.
                             Only on a row that HAS an enrollment, and only for the owner, matching the daemon's
                             own floor. What it replaced was one button under the list that revoked every paired
                             computer at once, including the ones mirroring ports for other people. -->
                        <div v-if="row.computer.sync && isOwner" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line-subtle pt-3">
                            <p class="min-w-0 flex-1 text-xs text-muted">
                                Revoking stops this computer reaching the sandbox at all. Nothing on it is deleted, and its agent stays installed.
                            </p>
                            <Button
                                size="small"
                                severity="danger"
                                label="Revoke access"
                                :disabled="working || revoking"
                                @click="confirmingRevoke = row.computer"
                            >
                                <template #icon><Icon name="times" /></template>
                            </Button>
                        </div>
                    </div>
                </template>
            </DisclosureRow>
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

        <!-- ENDING ONE PAIRING. What survives is named as carefully as what goes: the folder is the thing people
             are actually worried about, and it is untouched. -->
        <ConfirmDialog
            :open="confirmingUnpair !== undefined"
            :header="`Unpair ${confirmingUnpair?.group.title ?? `this sandbox`}?`"
            confirm-label="Unpair"
            :destructive="true"
            @cancel="confirmingUnpair = undefined"
            @confirm="confirmUnpair"
        >
            <p>
                <span class="font-mono text-content">{{ confirmingUnpair?.computer.label }}</span> stops syncing this sandbox's files and mirroring its
                ports. Everything already in its local folder stays exactly as it is.
            </p>
            <p v-if="confirmingUnpair?.group.folder?.localDir" class="mt-2 break-all font-mono text-xs text-content">
                {{ confirmingUnpair.group.folder.localDir }}
            </p>
            <p class="mt-2">Pairing it again means running a fresh command on that computer.</p>
        </ConfirmDialog>

        <!-- CUTTING ONE COMPUTER OFF. Named for the machine rather than the sandbox, because that is the scope,
             and explicit that it is this one and not the fleet: the button it replaces revoked every paired
             computer at once, which is the assumption a reader arrives with. -->
        <ConfirmDialog
            :open="confirmingRevoke !== undefined"
            :header="`Revoke ${confirmingRevoke?.label ?? `this computer`}'s access?`"
            confirm-label="Revoke access"
            confirm-icon="times"
            :destructive="true"
            :loading="revoking"
            @cancel="confirmingRevoke = undefined"
            @confirm="runRevoke"
        >
            <p>
                This computer alone loses access — every other paired computer keeps syncing. Its file sync stops and its mirrored ports drop off its
                localhost within a minute.
            </p>
            <p class="mt-2">
                Nothing on that computer is deleted and its agent stays installed, but letting it back in means running a fresh pairing command there.
            </p>
        </ConfirmDialog>
    </div>
</template>
