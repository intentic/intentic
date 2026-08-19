<!-- THE KIT, ON ONE PAGE — every shared part in every state it has, and every scale it is drawn from.
     Dev-only: the route is registered under `import.meta.env.DEV` (router/index.ts), so it is not in a
     production bundle and there is no guard to satisfy — it opens signed out, with no sandbox, in any theme.

     IT EXISTS TO MAKE DRIFT VISIBLE. The design system is documented better than most, and the drift the audit
     found still happened, because the two things that had drifted were never on screen together: thirteen
     dialog widths, two red boxes differing only in whether they carried a warning icon, and four captions
     rendered at sizes the scale does not contain. None of that is discoverable by reading a file. It is obvious
     the moment the variants sit in a row.

     SO THE SCALES ARE FIRST, before any component. A component gallery shows you what a part looks like; a
     SCALE shows you the decision behind it, which is the thing a call site is tempted to reinvent. Every band
     here prints the token name beside the sample, because the failure being prevented is somebody typing
     `text-[0.65rem]` for want of knowing `text-3xs` exists.

     WHAT IS NOT HERE, and deliberately: anything that needs the daemon, an agent, a repository or a signed-in
     user. The parts that carry app state (the chat surfaces, the fleet board) are not kit parts, and a gallery
     that has to boot a workspace is a gallery nobody opens. -->
<script setup lang="ts">
import {
    AnchoredOverlay,
    Avatar,
    BarChart,
    BrandMark,
    Card,
    ChangeStatusMark,
    ui,
    Code,
    CodeField,
    ConfirmDialog,
    CopyButton,
    StatusTally,
    DiffStat,
    FilterBar,
    InfoDialog,
    InfoHint,
    InfoTable,
    MachineDetail,
    type MachineFolderRow,
    MachineRunLog,
    type MachinePortRow,
    type MachineSandboxRow,
    Modal,
    Notice,
    Page,
    PageAction,
    PageHeader,
    ScrollFrame,
    Picker,
    type PickerOption,
    ProgressRing,
    ProseField,
    ResponsiveOverlay,
    Row,
    RowGroup,
    SandboxVerbs,
    SearchBar,
    SegmentedControl,
    SkeletonRows,
    StatStrip,
    StatusBadge,
    type StatusVariant,
    useTextSize,
    useTheme,
} from "@intentic/ui";
import Button from "primevue/button";
import { ref } from "vue";

const { scheme, set: setScheme } = useTheme();
const { textSize, setTextSize } = useTextSize();

/* Each band is a `[name, sample]` list rather than prose, so the page reads as a RULER: the name is what a
 * call site types, and the sample is what it gets. A band with one entry is a band with a decision nobody has
 * had to make yet — worth seeing as much as a crowded one. */
const TEXT_SIZES = [`text-4xs`, `text-3xs`, `text-2xs`, `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`] as const;
const RADII = [`rounded-xs`, `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-2xl`] as const;
/* SPELLED OUT, both of them, because Tailwind emits a utility only where it can SEE the name: a swatch class
 * built as `bg-${name}` is a class that ships as nothing at all, and a palette page that renders blank squares
 * is worse than no palette page. It is the same rule the series tokens record in semantic-colors.css, and this
 * is exactly the file that would have made the mistake. */
const ROLE_COLORS = [
    { name: `canvas`, swatch: `bg-canvas` },
    { name: `card`, swatch: `bg-card` },
    { name: `overlay`, swatch: `bg-overlay` },
    { name: `line`, swatch: `bg-line` },
    { name: `line-strong`, swatch: `bg-line-strong` },
    { name: `content`, swatch: `bg-content` },
    { name: `muted`, swatch: `bg-muted` },
    { name: `subtle`, swatch: `bg-subtle` },
    { name: `link`, swatch: `bg-link` },
    { name: `danger`, swatch: `bg-danger` },
    { name: `success`, swatch: `bg-success` },
    { name: `warning`, swatch: `bg-warning` },
    { name: `info`, swatch: `bg-info` },
] as const;
const SERIES = [
    { name: `series-1`, swatch: `bg-series-1` },
    { name: `series-2`, swatch: `bg-series-2` },
    { name: `series-3`, swatch: `bg-series-3` },
    { name: `series-4`, swatch: `bg-series-4` },
    { name: `series-5`, swatch: `bg-series-5` },
    { name: `series-other`, swatch: `bg-series-other` },
] as const;
const MODAL_SIZES = [`sm`, `md`, `lg`, `xl`, `full`] as const;
const READ_WIDTHS = [`max-w-read-xs`, `max-w-read-sm`, `max-w-read`, `max-w-read-lg`] as const;
const POP_WIDTHS = [`w-pop-sm`, `w-pop`, `w-pop-lg`] as const;
/* Heights are drawn as a SHARE OF THE VIEWPORT rather than as a column of that height: `h-panel` is 60dvh, and
 * four honest columns would be two thousand pixels of bar to say four numbers. The share is the fact anyway —
 * these exist to stop a panel growing past the window, so how much window it leaves is the whole content. */
const PANEL_HEIGHTS = [
    { name: `h-panel`, value: `60dvh`, share: 60 },
    { name: `h-panel-lg`, value: `72dvh`, share: 72 },
    { name: `h-panel-xl`, value: `85dvh`, share: 85 },
    { name: `h-figure`, value: `min(26rem, 50dvh)`, share: 50 },
] as const;
const STATUS_VARIANTS: readonly StatusVariant[] = [`success`, `danger`, `warning`, `info`, `neutral`, `primary`];

/* One machine, invented — a healthy sandbox and a stopped one that lost a port to it, which between them show
 * every state the row has: the running dot and the stopped word, a resting sync and a halted one, a mirrored
 * port and a contested one, and both halves of the power slot. */
const KIT_SANDBOXES: readonly MachineSandboxRow[] = [
    { slug: `work`, name: `work`, running: true, image: `ghcr.io/intentic/sandbox:2.3.1`, tunnelRunning: true },
    { slug: `lab`, name: `lab`, running: false, image: `ghcr.io/intentic/sandbox:2.2.9`, tunnelRunning: false },
];
/* BOTH SESSIONS ON BOTH ROWS, because a pairing now runs two: the workspace sync and the one-way mirror that
 * carries the sandbox's own state down. The healthy row states its backup explicitly rather than omitting it —
 * an omitted one reads as "not backed up" and would draw a warning on the sample whose whole job is to show
 * what a well pairing looks like, which is how a fixture starts lying about the component it demonstrates. */
const KIT_PAIRINGS: readonly MachineFolderRow[] = [
    { sandboxId: `work-intentic-dev`, mode: `sync`, localDir: `/home/ada/intentic/work`, mutagenStatus: `watching`, backupStatus: `watching` },
    { sandboxId: `lab-intentic-dev`, mode: `sync`, localDir: `/home/ada/intentic/lab`, mutagenStatus: `halted-on-root-emptied`, conflicts: 2 },
];
/* SEVERAL PORTS, NOT ONE, because one is the case that never went wrong. A sandbox routinely serves three or
 * four, and the layout that broke was exactly that: a wrapping row of tinted chips each trailed by a program
 * name, running together as a single string. A kit fixture that shows one port per sandbox hides the only
 * arrangement worth checking on this page. */
const KIT_PORTS: readonly MachinePortRow[] = [
    { port: 5173, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `/usr/bin/node /work/node_modules/.bin/vite` },
    { port: 33177, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `/usr/bin/node /work/backend-host-main.js` },
    { port: 33679, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `node main.js` },
    { port: 6379, sandboxId: `work-intentic-dev`, state: `busy`, command: `/usr/bin/docker-proxy -proto tcp -host-port 6379` },
    { port: 5173, sandboxId: `lab-intentic-dev`, state: `held-by-sandbox`, heldBy: `work-intentic-dev`, command: `node vite` },
];

// Live state for the parts that have any. One flag per surface, which is also what the surfaces themselves do.
const modalSize = ref<(typeof MODAL_SIZES)[number]>(`md`);
const modalOpen = ref(false);
const confirmOpen = ref(false);
const anchoredOpen = ref(false);
const responsiveOpen = ref(false);
const anchoredTrigger = ref<HTMLButtonElement | null>(null);
const responsiveTrigger = ref<HTMLButtonElement | null>(null);
const segment = ref(`all`);
const picked = ref<string | undefined>(`sonnet`);
const query = ref(``);
const filter = ref(``);
const prose = ref(`A paragraph typed into the writing field.`);
const source = ref(`export const greet = (who: string): string => \`hello \${who}\`;\n`);

const COUNTS = [
    { label: `running`, value: 3, variant: `success` as StatusVariant },
    { label: `stopped`, value: 1, variant: `neutral` as StatusVariant },
    { label: `need attention`, value: 2, variant: `danger` as StatusVariant },
];
const STATS = [
    { label: `Packages`, value: `12` },
    { label: `Lines of code`, value: `48.1k`, note: `excluding tests` },
    { label: `With tests`, value: `9 of 12` },
];
const BARS = [
    { label: `_editor/web`, value: 412 },
    { label: `_sandbox/sandbox`, value: 288 },
    { label: `_editor/ui`, value: 164 },
    { label: `_platform/api`, value: 96 },
];
const PICKER_OPTIONS = [
    { value: `sonnet`, label: `Claude Sonnet 5`, description: `The standing model` },
    { value: `opus`, label: `Claude Opus 5`, description: `For the hard ones` },
    { value: `haiku`, label: `Claude Haiku 5` },
];
// The hinted variant, side by side with the annotated one above: a choice whose options are TAUGHT on the row
// rather than named and left. Access tiers are the case it was built for.
const PICKER_HINTED = [
    { value: `viewer`, label: `Viewer`, icon: `eye`, hint: `Can watch everything — agents, chats, files. Can't change anything.` },
    {
        value: `collaborator`,
        label: `Collaborator`,
        icon: `users`,
        hint: `Can drive agents and review work. Landing and publishing become requests.`,
    },
    { value: `maintainer`, label: `Maintainer`, icon: `wrench`, hint: `Can ship and operate: land work, approve drafts, use the terminal.` },
] as const satisfies readonly PickerOption[];
const pickedTier = ref(`collaborator`);
</script>

<template>
    <Page width="full">
        <PageHeader title="Design kit" description="Every shared part, every state, and the scales they are drawn from.">
            <template #actions>
                <SegmentedControl
                    :model-value="scheme"
                    :options="[
                        { label: `Light`, value: `light` },
                        { label: `Dark`, value: `dark` },
                    ]"
                    @update:model-value="setScheme"
                />
                <SegmentedControl
                    :model-value="textSize"
                    :options="[
                        { label: `Compact`, value: `compact` },
                        { label: `Default`, value: `default` },
                        { label: `Large`, value: `large` },
                    ]"
                    @update:model-value="setTextSize"
                />
            </template>
        </PageHeader>

        <div class="flex flex-col gap-10 pb-16">
            <!-- ── THE SCALES ─────────────────────────────────────────────────────────────────────────── -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Type scale</h2>
                <RowGroup>
                    <Row v-for="name in TEXT_SIZES" :key="name" :title="name">
                        <template #meta><span :class="name">The quick brown fox jumps</span></template>
                    </Row>
                </RowGroup>
            </section>

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Role colours</h2>
                <p class="text-xs text-muted">These flip between light and dark. Reach for these before any numbered step.</p>
                <div class="flex flex-wrap gap-3">
                    <div v-for="role in ROLE_COLORS" :key="role.name" class="flex flex-col items-center gap-1">
                        <span class="h-10 w-20 rounded-md border border-line" :class="role.swatch"></span>
                        <span class="text-3xs text-subtle">{{ role.name }}</span>
                    </div>
                </div>
            </section>

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Chart series</h2>
                <p class="text-xs text-muted">Assign a slot to a thing once, never by rank. Slot order is part of the contrast guarantee.</p>
                <div class="flex flex-wrap gap-3">
                    <div v-for="slot in SERIES" :key="slot.name" class="flex flex-col items-center gap-1">
                        <span class="h-10 w-20 rounded-md" :class="slot.swatch"></span>
                        <span class="text-3xs text-subtle">{{ slot.name }}</span>
                    </div>
                </div>
            </section>

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Radii</h2>
                <div class="flex flex-wrap gap-3">
                    <div v-for="name in RADII" :key="name" class="flex flex-col items-center gap-1">
                        <span class="h-12 w-12 border border-line-strong bg-overlay" :class="name"></span>
                        <span class="text-3xs text-subtle">{{ name }}</span>
                    </div>
                </div>
            </section>

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Widths and heights</h2>
                <p class="text-xs text-muted">
                    Each carries its own viewport clamp, which is the half a hand-written width forgets. Narrow the window and watch them stop.
                </p>
                <div class="flex flex-col gap-2">
                    <!-- `w-full` under the cap, or a max-width on an empty box measures nothing and draws nothing. -->
                    <div v-for="name in READ_WIDTHS" :key="name" class="flex items-center gap-3">
                        <span class="w-32 shrink-0 text-3xs text-subtle">{{ name }}</span>
                        <span class="block h-4 w-full rounded bg-primary-500/30" :class="name"></span>
                    </div>
                    <div v-for="name in POP_WIDTHS" :key="name" class="flex items-center gap-3">
                        <span class="w-32 shrink-0 text-3xs text-subtle">{{ name }}</span>
                        <span class="block h-4 rounded bg-info/30" :class="name"></span>
                    </div>
                    <div v-for="name in MODAL_SIZES" :key="name" class="flex items-center gap-3">
                        <span class="w-32 shrink-0 text-3xs text-subtle">Modal {{ name }}</span>
                        <span
                            class="block h-4 rounded bg-success/30"
                            :class="{
                                'w-modal-sm': name === `sm`,
                                'w-modal': name === `md`,
                                'w-modal-lg': name === `lg`,
                                'w-modal-xl': name === `xl`,
                                'w-modal-full': name === `full`,
                            }"
                        ></span>
                    </div>
                    <div v-for="height in PANEL_HEIGHTS" :key="height.name" class="flex items-center gap-3">
                        <span class="w-32 shrink-0 text-3xs text-subtle">{{ height.name }}</span>
                        <span class="block h-4 rounded bg-warning/30" :style="{ width: `${height.share}%` }"></span>
                        <span class="text-3xs text-subtle">{{ height.value }}</span>
                    </div>
                </div>
            </section>

            <!-- ── SAYING SOMETHING WENT WRONG ────────────────────────────────────────────────────────── -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Notice</h2>
                <p class="text-xs text-muted">
                    The app's one tinted message box. `:of` when the message is data, the slot when the view wrote it — both wear the same box.
                </p>
                <div class="flex max-w-read-lg flex-col gap-2">
                    <Notice :of="{ tone: `danger`, title: `Couldn't reach the sandbox.`, detail: `fetch failed: ECONNREFUSED 127.0.0.1:6480` }" />
                    <Notice :of="{ tone: `warning`, title: `Two files are still unsaved.` }" />
                    <Notice :of="{ tone: `info`, title: `A newer version installs when you quit.` }" />
                    <Notice
                        :of="{
                            tone: `danger`,
                            title: `The push was rejected.`,
                            detail: `non-fast-forward`,
                            action: { label: `Retry`, run: () => {} },
                        }"
                        dismiss-label="Dismiss"
                    />
                    <Notice tone="info">
                        The authored case: a sentence with <b>emphasis</b> and a <code class="ui-code">token</code> in it, which no model of plain
                        strings can carry.
                    </Notice>
                    <Notice tone="warning" icon="clock">An icon override, for when the glyph says something the tone does not.</Notice>
                </div>
            </section>

            <!-- ── CONTAINERS ────────────────────────────────────────────────────────────────────────── -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Containers</h2>
                <p class="text-xs text-muted">
                    Card is the box. ScrollFrame is the box that scrolls itself — it owns the contract, so a view never writes one. A docked pane that
                    fills a region the shell already framed wants neither.
                </p>
                <div class="flex flex-wrap items-start gap-4">
                    <Card class="w-64"><p class="text-xs text-content">A card. Padding and radius come from the density tokens.</p></Card>
                    <Card dashed class="w-64"><p class="text-xs text-muted">A dashed card — the empty state.</p></Card>
                    <!-- `grow` inside a fixed-height flex parent, which is the whole of how this is used: the frame
                         is sized by its content otherwise, and a wrapper's height constrains nothing. -->
                    <div class="flex h-56 w-72 flex-col">
                        <ScrollFrame grow title="ScrollFrame" description="Header stays, body scrolls">
                            <div class="flex flex-col gap-2 p-3">
                                <p v-for="line in 12" :key="line" class="text-xs text-muted">Body line {{ line }}</p>
                            </div>
                        </ScrollFrame>
                    </div>
                </div>
            </section>

            <!-- ── LISTS ─────────────────────────────────────────────────────────────────────────────── -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Rows</h2>
                <div class="grid gap-4 md:grid-cols-2">
                    <RowGroup label="States" :count="4">
                        <Row title="Plain row" description="A title and its description" />
                        <Row title="With facts" description="Facts are muted and never focusable">
                            <template #meta><span class="text-2xs text-subtle">3 files</span><DiffStat :additions="12" :deletions="4" /></template>
                        </Row>
                        <Row title="With a control" description="Actions carry their own hit area">
                            <template #control><Button size="small" severity="secondary" label="Open" /></template>
                        </Row>
                        <Row title="Navigational" description="Interactive, with a chevron" interactive chevron />
                    </RowGroup>
                    <RowGroup label="Loading">
                        <SkeletonRows :rows="4" description control />
                    </RowGroup>
                </div>
            </section>

            <!-- ── ONE COMPUTER'S SANDBOXES ──────────────────────────────────────────────────────────── -->
            <!-- Here because TWO apps draw this: the Computers tab and the desktop app's manager window. That
                 window cannot be opened in a browser, so this is the only place the two can be compared side by
                 side — which is exactly how they drifted into different button sets in the first place. -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">A machine's sandboxes</h2>
                <div class="rounded-xl border border-line bg-canvas p-4">
                    <MachineDetail :pairings="KIT_PAIRINGS" :ports="KIT_PORTS" :sandboxes="KIT_SANDBOXES" :watcher="{ running: true, pid: 4821 }">
                        <template #heading><span :class="ui.sectionLabel()">Sandboxes on this computer</span></template>
                        <template #actions="{ group }">
                            <SandboxVerbs v-if="group.sandbox" :running="group.sandbox.running" />
                        </template>
                    </MachineDetail>
                </div>
                <MachineRunLog
                    :lines="[`intentic: pulling ghcr.io/intentic/sandbox:stable`, `intentic: recreating the container`, `ready`]"
                    :running="true"
                    note="Running on that computer — it keeps going even if you leave this page."
                />
            </section>

            <!-- ── MARKS AND BADGES ──────────────────────────────────────────────────────────────────── -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Badges and marks</h2>
                <div class="flex flex-wrap items-center gap-2">
                    <StatusBadge v-for="variant in STATUS_VARIANTS" :key="variant" :variant="variant" :label="variant" />
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <StatusBadge v-for="variant in STATUS_VARIANTS" :key="variant" :variant="variant" :label="variant" dot size="sm" />
                </div>
                <div class="flex flex-wrap items-center gap-4">
                    <span class="flex items-center gap-2"
                        ><ChangeStatusMark status="modified" /><span class="text-xs text-content">modified</span></span
                    >
                    <span class="flex items-center gap-2"><ChangeStatusMark status="added" /><span class="text-xs text-content">added</span></span>
                    <span class="flex items-center gap-2"
                        ><ChangeStatusMark status="deleted" /><span class="text-xs text-content">deleted</span></span
                    >
                    <DiffStat :additions="128" :deletions="42" />
                    <ProgressRing :value="0.41" :size="24" />
                    <ProgressRing :value="0.86" :size="24" />
                    <Avatar :size="28" name="Ada Lovelace" />
                    <BrandMark :size="28" name="GitHub" icon="github" />
                    <CopyButton text="copied from the design kit" label="Copy" />
                    <InfoHint label="What this is">
                        <span class="block text-xs text-content">A hover card. It holds a couple of sentences — more than that wants a dialog.</span>
                    </InfoHint>
                    <InfoDialog title="The long version">
                        <p class="text-sm text-content">The click-to-open sibling of the hint: headings, lists, several paragraphs, selectable.</p>
                    </InfoDialog>
                </div>
            </section>

            <!-- ── FIGURES ───────────────────────────────────────────────────────────────────────────── -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Figures</h2>
                <p class="text-xs text-muted">
                    Three shapes that look alike in a list of names and are not: a tally line, a stat strip, a bar chart.
                </p>
                <StatusTally :items="COUNTS" />
                <StatStrip :items="STATS" />
                <div class="max-w-read-lg"><BarChart :items="BARS" /></div>
                <div class="max-w-read-lg">
                    <InfoTable
                        :headers="[``, `Card`, `ScrollFrame`]"
                        :rows="[
                            [`Scrolls itself`, `no`, `yes`],
                            [`Has a header`, `no`, `optional`],
                            [`Draws its own edges`, `yes`, `yes`],
                            [`Use for`, `a box of content`, `a panel with a body`],
                        ]"
                    />
                </div>
            </section>

            <!-- ── CONTROLS ──────────────────────────────────────────────────────────────────────────── -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Controls</h2>
                <div class="flex flex-wrap items-center gap-3">
                    <Button label="Primary" />
                    <Button label="Secondary" severity="secondary" />
                    <Button label="Danger" severity="danger" />
                    <Button label="Small" size="small" />
                    <Button label="Text" :text="true" severity="secondary" />
                    <PageAction label="Refresh" icon="refresh" hint="Re-read everything" />
                    <PageAction label="Quiet" icon="cog" quiet />
                    <button type="button" :class="ui.linkButton()">ui.linkButton</button>
                    <button type="button" :class="ui.addTile(`px-3 py-1.5`)">ui.addTile</button>
                    <button type="button" :class="ui.iconButton()"><Icon name="cog" class="text-xs" /></button>
                </div>
                <div class="grid max-w-read-lg gap-3 md:grid-cols-2">
                    <label class="ui-field">
                        <span class="ui-field-label">ui.input</span>
                        <input :class="ui.input()" placeholder="A single-line field" />
                    </label>
                    <label class="ui-field">
                        <span class="ui-field-label">Picker</span>
                        <Picker v-model="picked" :options="PICKER_OPTIONS" aria-label="Model" class="w-full" />
                    </label>
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">Picker — hinted rows, ghost trigger</span>
                        <div>
                            <Picker v-model="pickedTier" :options="PICKER_HINTED" variant="ghost" aria-label="Access tier" header="Access tier" />
                        </div>
                    </div>
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">SearchBar</span>
                        <SearchBar v-model="query" placeholder="Filter files…" />
                    </div>
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">FilterBar</span>
                        <FilterBar v-model="filter" placeholder="Filter…" :count="7" />
                    </div>
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">SegmentedControl</span>
                        <SegmentedControl
                            v-model="segment"
                            :options="[
                                { label: `All`, value: `all`, badge: 12 },
                                { label: `Mine`, value: `mine` },
                                { label: `Failing`, value: `bad`, badge: 2 },
                            ]"
                        />
                    </div>
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">ui.emptyState</span>
                        <div :class="ui.emptyState()">Nothing here yet.</div>
                    </div>
                </div>
                <div class="grid max-w-read-lg gap-3 md:grid-cols-2">
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">ProseField</span>
                        <ProseField v-model="prose" placeholder="Write something…" />
                    </div>
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">CodeField</span>
                        <CodeField v-model="source" lang="typescript" />
                    </div>
                </div>
                <div class="max-w-read-lg">
                    <span class="ui-field-label">Code</span>
                    <Code :code="source" lang="typescript" />
                </div>
            </section>

            <!-- ── THINGS THAT OPEN ──────────────────────────────────────────────────────────────────── -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Overlays</h2>
                <p class="text-xs text-muted">
                    Every one of these measures its room against the window its anchor is in, which is what makes them right inside a popped-out
                    panel.
                </p>
                <div class="flex flex-wrap items-center gap-3">
                    <SegmentedControl v-model="modalSize" :options="MODAL_SIZES.map((value) => ({ label: value, value }))" size="sm" />
                    <Button size="small" label="Open modal" @click="modalOpen = true" />
                    <Button size="small" severity="danger" label="Open confirm" @click="confirmOpen = true" />
                    <button ref="anchoredTrigger" type="button" :class="ui.addTile(`px-3 py-1.5`)" @click="anchoredOpen = !anchoredOpen">
                        Anchored overlay
                    </button>
                    <button ref="responsiveTrigger" type="button" :class="ui.addTile(`px-3 py-1.5`)" @click="responsiveOpen = !responsiveOpen">
                        Responsive overlay
                    </button>
                </div>
            </section>
        </div>

        <Modal v-model:open="modalOpen" :size="modalSize" header="A modal">
            <p class="text-sm text-content">
                Size <b>{{ modalSize }}</b
                >. Narrow the window past it and the clamp takes over — that clamp is the whole reason this component exists.
            </p>
            <p v-for="line in 14" :key="line" class="mt-2 text-xs text-muted">Body line {{ line }}, so the scroll cap has something to cap.</p>
            <template #footer>
                <Button label="Cancel" severity="secondary" :text="true" @click="modalOpen = false" />
                <Button label="Save" @click="modalOpen = false" />
            </template>
        </Modal>

        <ConfirmDialog
            :open="confirmOpen"
            header="Delete these files?"
            confirm-label="Delete"
            confirm-icon="trash"
            :items="[`src/lib/checkout.ts`, `src/pricing/CheckoutPanel.tsx`, `tests/checkout.spec.ts`]"
            @cancel="confirmOpen = false"
            @confirm="confirmOpen = false"
        >
            <template #item="{ item }"
                ><span class="truncate text-content">{{ item }}</span></template
            >
            <p class="mt-3 text-xs text-muted">This can't be undone.</p>
        </ConfirmDialog>

        <AnchoredOverlay v-model="anchoredOpen" :anchor="anchoredTrigger ?? undefined" side="bottom" cross="start">
            <div class="flex w-64 flex-col gap-1 p-2">
                <p class="text-xs text-content">Hangs off its trigger, flips when there is no room, clamps into the viewport.</p>
            </div>
        </AnchoredOverlay>

        <ResponsiveOverlay
            v-model="responsiveOpen"
            :anchor="responsiveTrigger ?? undefined"
            header="Responsive overlay"
            side="bottom"
            cross="start"
            panel-class="w-64"
        >
            <div class="flex flex-col gap-1 p-2">
                <p class="text-xs text-content">The same panel on a desktop; a thumb-reachable sheet on a phone. One open flag.</p>
            </div>
        </ResponsiveOverlay>
    </Page>
</template>
