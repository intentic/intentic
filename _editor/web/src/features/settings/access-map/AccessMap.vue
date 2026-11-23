<script setup lang="ts">
import { Button, Icon, SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { settingKey, storedValue, storeValue } from "@intentic/ui/storage";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import AccessMapExposures from "./AccessMapExposures.vue";
import AccessMapList from "./AccessMapList.vue";
import AccessMapStage from "./AccessMapStage.vue";
import { lightingOf } from "./accountGraph";
import { readWhen } from "./accessMapWords";
import { useAccountReach } from "./useAccountReach";

// SETTINGS ▸ ACCESS MAP: everything the signed-in account reaches, across every sandbox it is in. The account on the left,
// its sandboxes in the middle (its own, those shared with it, and those met only at the far end of a link), and the
// computers, phones, browsers, servers and cloud they reach on the right. What deserves reading first is said above it in
// sentences. What each tie allows is drawn on the card it lands on, as a row of glyphs that each name themselves when
// pointed at, so nothing has to be read in a caption. Pointing at anything lights what it is tied to; pressing keeps it
// lit.
//
// Read only, like the sandbox's own map: every line comes from what each sandbox's daemon enforces (GET /system/reach),
// read under the reader's own session there, and every change is made on the page that owns it. docs/architecture/accounts.md
// says how the answers are joined and how fresh each is.

const t = useT();
const { user } = useAuth();
const { graph, reads, reading, reread, readNow } = useAccountReach();

// A clock for the "read 2 minutes ago" words, moved twice a minute.
const now = shallowRef(Date.now());
let ticking: ReturnType<typeof setInterval> | undefined;

const hovered = shallowRef<string>();
const pinned = shallowRef<string>();
const focus = computed(() => hovered.value ?? pinned.value);
const lighting = computed(() => (focus.value === undefined ? undefined : lightingOf(graph.value, focus.value)));

// Leaving one card for the next crosses a gap: the old focus holds a beat, so the map does not flash dark in between.
const LEAVE_GRACE_MS = 90;
let leaving: ReturnType<typeof setTimeout> | undefined;
const point = (next: string | undefined): void => {
    clearTimeout(leaving);
    if (next !== undefined) {
        hovered.value = next;
        return;
    }
    leaving = setTimeout(() => (hovered.value = undefined), LEAVE_GRACE_MS);
};
const press = (next: string): void => {
    pinned.value = pinned.value === next ? undefined : next;
};
const clear = (): void => {
    pinned.value = undefined;
    hovered.value = undefined;
};
// A pinned thing that left the map (a link revoked, a computer unpaired) stops holding the focus.
watch(graph, (next) => {
    if (pinned.value !== undefined && pinned.value !== next.you.id && !next.nodes.has(pinned.value)) {
        pinned.value = undefined;
    }
});

const onKey = (event: KeyboardEvent): void => {
    if (event.key === `Escape` && pinned.value !== undefined) {
        clear();
    }
};

// Three columns need this much room; narrower, the same thing is said in words.
const ACROSS_FROM = 640;
const root = ref<HTMLElement>();
const width = shallowRef(0);
const observer = new ResizeObserver(([entry]) => {
    width.value = entry?.contentRect.width ?? 0;
});
onMounted(() => {
    window.addEventListener(`keydown`, onKey);
    ticking = setInterval(() => (now.value = Date.now()), 30_000);
    if (root.value !== undefined) {
        observer.observe(root.value);
    }
});
onBeforeUnmount(() => {
    window.removeEventListener(`keydown`, onKey);
    clearTimeout(leaving);
    clearInterval(ticking);
    observer.disconnect();
});

// The map first; the reader's choice is the account's setting (@intentic/ui/storage), a view preference.
type View = `map` | `list`;
const VIEW_KEY = settingKey(`intentic.accessMap.view`);
const view = shallowRef<View>(storedValue(VIEW_KEY) === `list` ? `list` : `map`);
const setView = (next: View): void => {
    view.value = next;
    storeValue(VIEW_KEY, next);
};
const views = computed(() => [
    { label: t(`settings.accessMap.viewMap`), value: `map` as const },
    { label: t(`settings.accessMap.viewList`), value: `list` as const },
]);
const narrow = computed(() => width.value > 0 && width.value < ACROSS_FROM);
const drawn = computed<View>(() => (narrow.value ? `list` : view.value));

// The line under the title: how much the account reaches, and how fresh the reading is.
const own = computed(() => graph.value.sandboxes.filter((sandbox) => sandbox.standing !== `beyond`));
const devices = computed(() => graph.value.machines.filter((machine) => machine.kind === `computer` || machine.kind === `phone` || machine.kind === `browser`).length);
const servers = computed(() => graph.value.machines.filter((machine) => machine.kind === `server`).length);
const tally = computed(() =>
    [
        t(`settings.accessMap.sandboxes`, { count: own.value.length }, own.value.length),
        devices.value > 0 ? t(`settings.accessMap.devices`, { count: devices.value }, devices.value) : undefined,
        servers.value > 0 ? t(`settings.accessMap.servers`, { count: servers.value }, servers.value) : undefined,
    ].filter((part) => part !== undefined),
);
const freshness = computed(() => {
    if (reading.value) {
        return t(`settings.accessMap.reading`);
    }
    const unread = own.value.filter((sandbox) => sandbox.read !== `fresh`).length;
    const newest = Math.max(0, ...own.value.filter((sandbox) => sandbox.read === `fresh`).map((sandbox) => sandbox.readAt ?? 0));
    return [
        newest > 0 ? readWhen(newest, now.value) : undefined,
        unread > 0 ? t(`settings.accessMap.unread`, { count: unread }, unread) : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
});

const rereading = shallowRef(false);
const again = async (): Promise<void> => {
    if (rereading.value) {
        return;
    }
    rereading.value = true;
    try {
        await reread();
    } finally {
        rereading.value = false;
    }
};
const readOne = (sandboxId: string): void => void readNow(sandboxId);

// The focus's ink, mixed into the theme so it tints rather than shouts, as on the sandbox's map (SandboxMap.vue); a tie
// between two sandboxes keeps a little of the link ink at rest.
const look = {
    "--map-ink": `var(--color-link)`,
    "--map-line": `color-mix(in oklab, var(--color-line-strong) 70%, var(--color-content))`,
    "--map-stroke": `color-mix(in oklab, var(--map-ink) 82%, var(--color-card))`,
    "--map-edge": `color-mix(in oklab, var(--map-ink) 38%, var(--color-line))`,
    "--map-edge-strong": `color-mix(in oklab, var(--map-ink) 60%, var(--color-line))`,
    "--map-wash": `color-mix(in oklab, var(--map-ink) 6%, var(--color-card))`,
    "--map-halo": `0 0 0 3px color-mix(in oklab, var(--map-ink) 12%, transparent)`,
    "--access-link": `color-mix(in oklab, var(--color-link) 55%, var(--color-line-strong))`,
};
</script>

<template>
    <div ref="root" class="flex flex-col gap-5" :style="look" data-setting="access-map">
        <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex min-w-0 flex-col gap-1">
                <p class="max-w-prose text-sm text-muted">{{ t(`settings.accessMap.intro`) }}</p>
                <p class="text-xs text-subtle">
                    <span class="text-content">{{ tally.join(` · `) }}</span>
                    <template v-if="freshness !== ``"> · {{ freshness }}</template>
                </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
                <SegmentedControl
                    v-if="!narrow"
                    size="xs"
                    :model-value="view"
                    :options="views"
                    :aria-label="t(`settings.accessMap.view`)"
                    @update:model-value="setView"
                />
                <Button size="small" tier="boring" :label="t(`settings.accessMap.reread`)" :loading="rereading" @click="again">
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </div>
        </div>

        <p v-if="own.length === 0" class="text-sm text-muted">{{ t(`settings.accessMap.empty`) }}</p>
        <template v-else>
            <AccessMapExposures :graph :showable="drawn === `map`" @show="press" />

            <template v-if="drawn === `map`">
                <!-- One line: the four kinds of line, then the two marks that say whose a row of glyphs is. -->
                <ul class="flex h-5 min-w-0 flex-wrap items-center gap-x-4 overflow-hidden text-xs text-subtle" aria-hidden="true">
                    <li class="flex items-center gap-1.5"><span class="h-px w-5 bg-(--map-line)" />{{ t(`settings.accessMap.legend.yours`) }}</li>
                    <li class="flex items-center gap-1.5"><span class="w-5 border-t border-dashed border-(--map-line) opacity-60" />{{ t(`settings.accessMap.legend.others`) }}</li>
                    <li class="flex items-center gap-1.5"><span class="h-px w-5 bg-(--access-link)" />{{ t(`settings.accessMap.legend.link`) }}</li>
                    <li class="flex items-center gap-1.5"><span class="w-5 border-t border-dotted border-(--map-line)" />{{ t(`settings.accessMap.legend.runs`) }}</li>
                    <li class="flex items-center gap-1.5"><Icon name="robot" />{{ t(`settings.accessMap.glyph.agents`) }}</li>
                    <li class="flex items-center gap-1.5"><Icon name="users" />{{ t(`settings.accessMap.glyph.people`) }}</li>
                </ul>
                <AccessMapStage :graph :lighting :focus :pinned :now :picture="user?.image" @point="point" @press="press" @clear="clear" @read="readOne" />
            </template>
            <template v-else>
                <p v-if="narrow" class="text-xs text-subtle">{{ t(`settings.accessMap.narrow`) }}</p>
                <AccessMapList :graph :now @read="readOne" />
            </template>
        </template>
    </div>
</template>
