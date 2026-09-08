<!--
    Dev-only page (behind `import.meta.env.DEV`) showing every shared component, state and scale together so drift between them is visible on one
    screen. Scales render before components, each token name printed beside its sample. Excludes anything needing the daemon, an agent, a repository
    or a signed-in user.
-->
<script setup lang="ts">
import {
    AnchoredOverlay,
    Avatar,
    BarChart,
    BrandMark,
    Button,
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
    DeviceDetail,
    type DeviceFolderRow,
    DeviceRunLog,
    mirroringOff,
    type DevicePortRow,
    type DeviceSandboxRow,
    MarkdownDocument,
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
    DisclosureRow,
    Row,
    RowGroup,
    RowNote,
    SandboxResourcesDialog,
    SandboxVerbs,
    SearchBar,
    SegmentedControl,
    SkeletonRows,
    StatStrip,
    StatusBadge,
    type StatusVariant,
    useTextSize,
    useTheme,
    Verdict,
} from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { ref } from "vue";

const { scheme, set: setScheme } = useTheme();
const { textSize, setTextSize } = useTextSize();

// Each band is a [name, sample] pair: the name is what a call site types, the sample is what it gets.
const TEXT_SIZES = [`text-4xs`, `text-3xs`, `text-2xs`, `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`] as const;
const RADII = [`rounded-xs`, `rounded-sm`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-2xl`] as const;
// Spelled out per swatch: Tailwind only emits a class it can see, so `bg-${name}` would purge to nothing.
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
// share is what matters: these clamp a panel's growth relative to the viewport, not an absolute height.
const PANEL_HEIGHTS = [
    { name: `h-panel`, value: `60dvh`, share: 60 },
    { name: `h-panel-lg`, value: `72dvh`, share: 72 },
    { name: `h-panel-xl`, value: `85dvh`, share: 85 },
    { name: `h-figure`, value: `min(26rem, 50dvh)`, share: 50 },
] as const;
const STATUS_VARIANTS: readonly StatusVariant[] = [`success`, `danger`, `warning`, `info`, `neutral`, `primary`];

// Two sandboxes cover every row state: run/stop, sync/halted, mirrored/contested port, both power states.
const KIT_SANDBOXES: readonly DeviceSandboxRow[] = [
    // Only row with resources set: exercises the Share line and the privileged toggle drawn locked.
    {
        slug: `work`,
        name: `work`,
        running: true,
        image: `ghcr.io/intentic/sandbox:2.3.1`,
        tunnelRunning: true,
        resources: { memoryBytes: 12 * 1024 ** 3, cpus: 4, privileged: true, gpu: false, hostRuntime: [], overlayRuntime: [`--privileged`] },
    },
    { slug: `lab`, name: `lab`, running: false, image: `ghcr.io/intentic/sandbox:2.2.9`, tunnelRunning: false },
    { slug: `hold`, name: `hold`, running: true, image: `ghcr.io/intentic/sandbox:2.3.1`, tunnelRunning: true },
];
// Healthy rows state both sync and backup explicitly; omitting one would misread as not backed up.
// Third row: mirroring off, no ports — an empty list also means a quiet sandbox, not a fault.
const KIT_PAIRINGS: readonly DeviceFolderRow[] = [
    { sandboxId: `work-intentic-dev`, mode: `sync`, localDir: `/home/ada/intentic/work`, mutagenStatus: `watching`, backupStatus: `watching` },
    { sandboxId: `lab-intentic-dev`, mode: `sync`, localDir: `/home/ada/intentic/lab`, mutagenStatus: `halted-on-root-emptied`, conflicts: 2 },
    {
        sandboxId: `hold-intentic-dev`,
        mode: `sync`,
        localDir: `/home/ada/intentic/hold`,
        mutagenStatus: `watching`,
        backupStatus: `watching`,
        mirroring: `off`,
    },
];
// Several ports, not one: a wrapping row of chips is the layout that actually broke.
const KIT_PORTS: readonly DevicePortRow[] = [
    { port: 5173, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `/usr/bin/node /work/node_modules/.bin/vite` },
    { port: 33177, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `/usr/bin/node /work/backend-host-main.js` },
    { port: 33679, sandboxId: `work-intentic-dev`, state: `mirrored`, command: `node main.js` },
    { port: 6379, sandboxId: `work-intentic-dev`, state: `busy`, command: `/usr/bin/docker-proxy -proto tcp -host-port 6379` },
    { port: 5173, sandboxId: `lab-intentic-dev`, state: `held-by-sandbox`, heldBy: `work-intentic-dev`, command: `node vite` },
];

// One ref per stateful part, mirroring how each surface tracks its own flag.
const modalSize = ref<(typeof MODAL_SIZES)[number]>(`md`);
// Left open: a closed disclosure row shows nothing that could have drifted.
const kitRail = ref(true);
const kitDrawer = ref(true);
const kitBefore = ref(false);

const modalOpen = ref(false);
const confirmOpen = ref(false);
const anchoredOpen = ref(false);
const responsiveOpen = ref(false);
const resourcesOpen = ref(false);
const anchoredTrigger = ref<HTMLButtonElement | null>(null);
const responsiveTrigger = ref<HTMLButtonElement | null>(null);
const segment = ref(`all`);
const picked = ref<string | undefined>(`sonnet`);
const query = ref(``);
const filter = ref(``);
const prose = ref(`A paragraph typed into the writing field.`);
const source = ref(`export const greet = (who: string): string => \`hello \${who}\`;\n`);
// Held as a pair: `stored` is what drives the status line, so the demo needs a saved copy too.
const NOTE = `## A note\n\nClick a line and type. The block you are in shows its markup; the rest stay clean.\n\n- Enter opens the next item\n- Enter on an empty one ends the list\n- [ ] and a task box is a task box\n`;
const note = ref(NOTE);
const noteOnDisk = ref(NOTE);
const POLICY = `# Safety policy\n\nAsk before anything that **deletes**, and before pushing to \`main\`.\n`;
const policy = ref(POLICY);
const policyOnDisk = ref(POLICY);

// Order is the rank, top to bottom; the last three are tones, not ranks, and any of them can carry any rank. `warn`,
// not `warning`: PrimeVue 4's spelling — the old one silently paints the brand colour.
const BUTTON_TIERS = [
    { name: `Loud`, spelling: `class="ui-button-loud"`, props: { class: `ui-button-loud` } },
    { name: `Accent`, spelling: `<Button>`, props: {} },
    { name: `Boring`, spelling: `severity="secondary"`, props: { severity: `secondary` } },
    { name: `Quiet`, spelling: `:text="true"`, props: { severity: `secondary`, text: true } },
    { name: `Danger`, spelling: `severity="danger"`, props: { severity: `danger` } },
    { name: `Warn`, spelling: `severity="warn"`, props: { severity: `warn` } },
    { name: `Success`, spelling: `severity="success"`, props: { severity: `success` } },
];

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
// Hinted variant, beside the plain one above: options taught on the row itself, built for access tiers.
const PICKER_HINTED = [
    { value: `viewer`, label: `Viewer`, icon: `eye`, hint: `Can watch everything, agents, chats, files. Can't change anything.` },
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
                        { label: `Comfortable`, value: `default` },
                        { label: `Large`, value: `large` },
                    ]"
                    @update:model-value="setTextSize"
                />
            </template>
        </PageHeader>

        <div class="flex flex-col gap-10 pb-16">
            <!-- Scales -->
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

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Notice</h2>
                <p class="text-xs text-muted">
                    The app's one tinted message box. `:of` when the message is data, the slot when the view wrote it: both wear the same box.
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

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Containers</h2>
                <p class="text-xs text-muted">
                    Card is the box. ScrollFrame is the box that scrolls itself: it owns the contract, so a view never writes one. A docked pane that
                    fills a region the shell already framed wants neither.
                </p>
                <div class="flex flex-wrap items-start gap-4">
                    <Card class="w-64"><p class="text-xs text-content">A card. Padding and radius come from the density tokens.</p></Card>
                    <Card dashed class="w-64"><p class="text-xs text-muted">A dashed card: the empty state.</p></Card>
                    <!-- `grow` needs a fixed-height flex parent, or the frame sizes to content and the wrapper's height is inert. -->
                    <div class="flex h-56 w-72 flex-col">
                        <ScrollFrame grow title="ScrollFrame" description="Header stays, body scrolls">
                            <div class="flex flex-col gap-2 p-3">
                                <p v-for="line in 12" :key="line" class="text-xs text-muted">Body line {{ line }}</p>
                            </div>
                        </ScrollFrame>
                    </div>
                </div>
            </section>

            <!-- Lists -->
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
                    <!-- Default `#below` is full-width; `spine` hangs it off the row's mark for a block, not a continuing sentence. -->
                    <RowGroup label="Below: flush, and on a spine">
                        <Row icon="sitemap" title="Flush" description="The default: the block starts at the group's edge">
                            <template #below><p class="text-2xs text-muted">A sentence continuing the description wants this.</p></template>
                        </Row>
                        <Row spine icon="credit-card" title="On a spine" description="Hangs off the row's name, under its mark">
                            <template #below>
                                <Verdict tone="content" value="10" unit="of 40 turns judged simple" evidence="4 down-routed · 2 vetoed" />
                            </template>
                        </Row>
                    </RowGroup>
                </div>

                <!--
                    compact is <RowGroup>'s default; dense is the navigator rail, comfortable a card's masthead. Neither the rows, the outline, nor
                    the notes vary by size on their own.
                -->
                <h3 :class="ui.sectionLabel(`text-2xs`)">Tiers, and the lines that are not rows</h3>
                <div class="grid gap-4 md:grid-cols-3">
                    <RowGroup
                        v-for="tier in [`comfortable`, `compact`, `dense`] as const"
                        :key="tier"
                        :density="tier"
                        :label="tier"
                        :caption="tier === `compact` ? `every list — the default` : tier === `dense` ? `navigator rails` : `card mastheads`"
                    >
                        <!-- Mark size comes from the `#lead` slot's `mark`, not a literal number, so the columns can't drift apart. -->
                        <Row title="A record" description="Its mark is the tier's">
                            <template #lead="{ mark }"><BrandMark :size="mark" name="GitHub" icon="github" /></template>
                        </Row>
                        <SkeletonRows :rows="1" />
                        <RowNote>A sentence on the group's surface.</RowNote>
                        <RowNote variant="action" label="Add one" />
                        <RowNote variant="empty">Nothing here yet.</RowNote>
                    </RowGroup>
                </div>

                <!--
                    Every disclosure-row shape, side by side, both hit areas and bodies open at once, so the next one added is picked from a picture,
                    not guessed.
                -->
                <h3 :class="ui.sectionLabel(`text-2xs`)">Disclosure rows</h3>
                <div class="grid gap-4 md:grid-cols-2">
                    <RowGroup label="hit=header · body=rail" caption="evidence about the row, hung off its title">
                        <DisclosureRow v-model:open="kitRail" title="A turn that failed" description="Claude · from discord">
                            <template #lead><Icon name="sparkles" class="text-xs text-link" /></template>
                            <template #meta><span>4m 2s</span><span>2h ago</span></template>
                            <template #below>
                                <p class="font-mono text-2xs text-subtle">14:02:11 · error · rate limited</p>
                            </template>
                        </DisclosureRow>
                        <DisclosureRow title="Closed, for the chevron's other angle">
                            <template #lead><Icon name="cog" class="text-xs text-subtle" /></template>
                            <template #below><span>unused</span></template>
                        </DisclosureRow>
                        <DisclosureRow title="Nothing behind it" description="disabled: no arrow, no hover, no tab stop" disabled>
                            <template #lead><Icon name="box" class="text-xs text-subtle" /></template>
                        </DisclosureRow>
                    </RowGroup>

                    <RowGroup label="hit=pair · body=drawer" caption="a place of its own; the headline's link keeps its own press">
                        <DisclosureRow v-model:open="kitDrawer" body="drawer" hit="pair">
                            <template #lead><Icon name="wrench" class="text-sm text-subtle" /></template>
                            <!-- `w-fit` keeps the underline on the text; `block` would let the link's hit area span the row's full width. -->
                            <template #title>
                                <a href="#" class="block w-fit max-w-full hover:text-link hover:underline">A headline that navigates</a>
                            </template>
                            <template #description>press this line and the row opens; press the name and it navigates</template>
                            <template #control><Button size="small" severity="secondary" label="Run" /></template>
                            <template #below>
                                <p class="text-xs text-muted">A drawer takes the full width and no surface of its own: one row, one wash.</p>
                            </template>
                        </DisclosureRow>
                        <DisclosureRow v-model:open="kitBefore" body="drawer">
                            <!-- Selection column sits outside the toggle (a checkbox nested in a button is invalid) but inside the tint. -->
                            <template #before><Checkbox :model-value="true" binary size="small" class="ml-4" /></template>
                            <template #title>With a #before selection column</template>
                            <template #meta><StatusBadge variant="success" label="pass" size="xs" /></template>
                            <template #below><p class="text-xs text-muted">The tick narrows the next run; the row opens the story.</p></template>
                        </DisclosureRow>
                    </RowGroup>
                </div>
            </section>

            <!-- Shown here since the desktop app's manager window (which draws the same UI) can't be opened in a browser. -->
            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">A device's sandboxes</h2>
                <div class="rounded-xl border border-line bg-canvas p-4">
                    <DeviceDetail :pairings="KIT_PAIRINGS" :ports="KIT_PORTS" :sandboxes="KIT_SANDBOXES" :agent="{ running: true, pid: 4821 }">
                        <template #heading><span :class="ui.sectionLabel()">Sandboxes on this device</span></template>
                        <template #actions="{ group }">
                            <SandboxVerbs v-if="group.sandbox" :running="group.sandbox.running" />
                        </template>
                        <!-- Clears this device's localhost only, stops nothing in the sandbox; row three shows mirroring off. -->
                        <template #ports="{ group }">
                            <Button
                                size="small"
                                severity="secondary"
                                :text="true"
                                :label="mirroringOff(group.folder) ? `Start mirroring` : `Stop mirroring`"
                            />
                        </template>
                    </DeviceDetail>
                </div>
                <DeviceRunLog
                    :lines="[`intentic: pulling ghcr.io/intentic/sandbox:stable`, `intentic: recreating the container`, `ready`]"
                    :running="true"
                    note="Running on that device: it keeps going even if you leave this page."
                />
            </section>

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
                        <span class="block text-xs text-content">A hover card. It holds a couple of sentences: more than that wants a dialog.</span>
                    </InfoHint>
                    <InfoDialog title="The long version">
                        <p class="text-sm text-content">The click-to-open sibling of the hint: headings, lists, several paragraphs, selectable.</p>
                    </InfoDialog>
                </div>
            </section>

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Figures</h2>
                <p class="text-xs text-muted">
                    Four shapes that look alike in a list of names and are not: a tally line, a stat strip, a bar chart, and a verdict.
                </p>
                <StatusTally :items="COUNTS" />
                <StatStrip :items="STATS" />
                <!--
                    No container or margin of its own; the caller supplies both, on a card or inside a row's #below alike. With no figure, the value
                    is a plain word.
                -->
                <div class="flex flex-wrap items-start gap-x-10 gap-y-4">
                    <Verdict size="lg" tone="success" value="25%" unit="of command output removed" />
                    <Verdict tone="success" value="↓12%" unit="searches per turn" detail="±3.1pp (95%)" evidence="329 taught · 94 cold" />
                    <Verdict tone="muted" value="Off" unit="not being measured" />
                    <Verdict size="xs" tone="content" value="↑2%" unit="searches before the first file" />
                </div>
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

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Controls</h2>

                <!-- Every tier in every state, one grid, since the differences are only checkable side by side. Read down for rank, across for state. -->
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[34rem] border-separate border-spacing-x-3 border-spacing-y-2 text-left">
                        <thead>
                            <tr class="text-2xs uppercase tracking-wide text-subtle">
                                <th class="font-medium">Tier</th>
                                <th class="font-medium">Default (page, dialog)</th>
                                <th class="font-medium">Small (rows, toolbars)</th>
                                <th class="font-medium">Disabled</th>
                                <th class="font-medium">Working</th>
                            </tr>
                        </thead>
                        <tbody class="align-middle">
                            <tr v-for="tier in BUTTON_TIERS" :key="tier.name">
                                <td class="whitespace-nowrap text-2xs text-muted">
                                    <span class="font-medium text-content">{{ tier.name }}</span>
                                    <span class="ml-1 font-mono text-3xs text-subtle">{{ tier.spelling }}</span>
                                </td>
                                <td><Button v-bind="tier.props" label="Land now" /></td>
                                <td><Button v-bind="tier.props" label="Land now" size="small" /></td>
                                <td><Button v-bind="tier.props" label="Land now" size="small" :disabled="true" /></td>
                                <td><Button v-bind="tier.props" label="Land now" size="small" :loading="true" /></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p class="max-w-read text-2xs text-subtle">
                    Disabled is a flat plate with no rim, not a fade — a 0.6 fade of a 10% tint is a 6% tint and the control disappears, and every
                    live tier here draws a hairline, so a filled box without one is a shape nothing live can wear. Working keeps the tier it had: a
                    button that repaints itself as unavailable the instant it is pressed is answering the wrong question.
                </p>

                <!-- Shown beside the button since a hand-styled `<button>` usually means the alternative wasn't visible. -->
                <div class="flex flex-wrap items-center gap-4">
                    <button type="button" :class="ui.iconButton()"><Icon name="cog" class="text-xs" /></button>
                    <button type="button" :class="ui.linkButton()">ui.linkButton — will navigate</button>
                    <button type="button" :class="ui.textAction()"><Icon name="eye" />ui.textAction — acts in place</button>
                    <button type="button" class="ui-chip"><Icon name="filter" />ui-chip</button>
                    <button type="button" class="ui-chip ui-chip-on"><Icon name="filter" />ui-chip-on</button>
                    <button type="button" class="ui-chip" disabled><Icon name="filter" />disabled</button>
                    <button type="button" :class="ui.addTile(`px-3 py-1.5`)">ui.addTile</button>
                    <button type="button" :class="ui.overlayChip()"><Icon name="copy" class="text-2xs" />ui.overlayChip</button>
                </div>
                <div class="flex flex-wrap items-center gap-3">
                    <PageAction label="Refresh" icon="refresh" hint="Re-read everything" />
                    <PageAction label="Quiet" icon="cog" quiet />
                </div>
                <!--
                    tabindex isn't needed to see focus — click into any field. The disabled column is the one to check per skin: fields dim rather
                    than repaint.
                -->
                <div class="flex flex-col gap-2">
                    <span :class="ui.sectionLabel(`text-2xs`)">Fields: every variant against every state</span>
                    <!-- `minmax(0, 1fr)`, not bare `1fr`: a grid item's implicit min-width is auto and won't shrink otherwise. -->
                    <div
                        class="grid max-w-read-lg items-center gap-x-3 gap-y-2 text-2xs text-subtle"
                        style="grid-template-columns: max-content minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)"
                    >
                        <span></span><span>rest</span><span>invalid</span><span>disabled</span>

                        <span class="text-muted">ui.input</span>
                        <input :class="ui.input(`w-full`)" placeholder="38px, a page or a dialog" />
                        <input :class="[ui.input(`w-full`), `ui-field-error-box`]" placeholder="invalid" />
                        <input :class="ui.input(`w-full`)" placeholder="disabled" disabled />

                        <span class="text-muted">ui.inputSm</span>
                        <input :class="ui.inputSm(`w-full`)" placeholder="26px, a dense surface" />
                        <input :class="[ui.inputSm(`w-full`), `ui-field-error-box`]" placeholder="invalid" />
                        <input :class="ui.inputSm(`w-full`)" placeholder="disabled" disabled />

                        <span class="text-muted">ui.inputInline</span>
                        <input :class="ui.inputInline(`w-full px-1 text-xs`)" placeholder="stands where text stood" />
                        <input :class="[ui.inputInline(`w-full px-1 text-xs`), `ui-field-error-box`]" placeholder="invalid" />
                        <input :class="ui.inputInline(`w-full px-1 text-xs`)" placeholder="disabled" disabled />

                        <span class="text-muted">field-bare<br />in ui-field-shell</span>
                        <div class="ui-field-shell flex items-center gap-2 px-2.5 py-1.5">
                            <span class="select-none font-mono text-xs text-subtle" aria-hidden="true">$</span>
                            <input class="field-bare min-w-0 flex-1 font-mono md:text-xs" placeholder="the shell takes the focus" />
                        </div>
                        <div class="ui-field-shell ui-field-error-box flex items-center gap-2 px-2.5 py-1.5">
                            <span class="select-none font-mono text-xs text-subtle" aria-hidden="true">$</span>
                            <input class="field-bare min-w-0 flex-1 font-mono md:text-xs" placeholder="invalid" />
                        </div>
                        <div class="ui-field-shell flex items-center gap-2 px-2.5 py-1.5 opacity-50">
                            <span class="select-none font-mono text-xs text-subtle" aria-hidden="true">$</span>
                            <input class="field-bare min-w-0 flex-1 font-mono md:text-xs" placeholder="disabled" disabled />
                        </div>
                    </div>
                    <!-- Inputs sit in an overflow-hidden box: an outward ring would clip and bleed into its neighbor; inset can't. -->
                    <div class="ui-card flex max-w-read-lg gap-1 overflow-hidden p-0">
                        <input :class="ui.inputSm(`min-w-0 flex-1`)" placeholder="clipped container, 4px apart" />
                        <input :class="ui.inputSm(`min-w-0 flex-1`)" placeholder="…and neither ring escapes" />
                    </div>
                </div>
                <div class="grid max-w-read-lg gap-3 md:grid-cols-2">
                    <label class="ui-field">
                        <span class="ui-field-label">Picker</span>
                        <Picker v-model="picked" :options="PICKER_OPTIONS" aria-label="Model" class="w-full" />
                    </label>
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">Picker: hinted rows, ghost trigger</span>
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
                <!--
                    Not a code field or a prose field: a markdown document is neither source nor a plain paragraph. Both save modes (auto, explicit)
                    are shown since that's the caller's one real choice.
                -->
                <div class="grid max-w-read-lg gap-6 md:grid-cols-2">
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">MarkdownDocument · save="auto"</span>
                        <div class="ui-field-shell p-3">
                            <MarkdownDocument v-model="note" editable :stored="noteOnDisk" save="auto" label="A note" @save="noteOnDisk = $event">
                                <template #note>Written as you type, like the file it is.</template>
                            </MarkdownDocument>
                        </div>
                    </div>
                    <div class="flex flex-col gap-1">
                        <span class="ui-field-label">MarkdownDocument · save="explicit"</span>
                        <div class="ui-field-shell p-3">
                            <MarkdownDocument
                                v-model="policy"
                                editable
                                :stored="policyOnDisk"
                                save="explicit"
                                label="A policy"
                                @save="policyOnDisk = $event"
                            >
                                <template #note>Every turn reads this, so it waits to be told.</template>
                            </MarkdownDocument>
                        </div>
                    </div>
                </div>
            </section>

            <section class="flex flex-col gap-4">
                <h2 :class="ui.sectionLabel()">Overlays</h2>
                <p class="text-xs text-muted">
                    Every one of these measures its room against the window its anchor is in, which is what makes them right inside a floating panel.
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
                    <Button size="small" label="Open resources" @click="resourcesOpen = true" />
                </div>
            </section>
        </div>

        <Modal v-model:open="modalOpen" :size="modalSize" header="A modal">
            <p class="text-sm text-content">
                Size <b>{{ modalSize }}</b
                >. Narrow the window past it and the clamp takes over: that clamp is the whole reason this component exists.
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

        <!--
            Same fixture the Share line above reads from, so the two views can't drift apart. Engine is 32 GiB / 8 cores so the rails read as real
            numbers; `work` needs --privileged, so its switch draws locked.
        -->
        <SandboxResourcesDialog
            :open="resourcesOpen"
            name="work"
            :current="KIT_SANDBOXES[0]?.resources"
            :engine="{ memoryBytes: 32 * 1024 ** 3, cpus: 8 }"
            @cancel="resourcesOpen = false"
            @apply="resourcesOpen = false"
        />

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
