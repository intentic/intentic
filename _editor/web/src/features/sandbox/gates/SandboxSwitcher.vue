<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import type { SandboxSummary } from "@intentic/api-contract";
import {
    AnchoredOverlay,
    browserOwnsClick,
    Button,
    Code,
    commandLang,
    ConfirmDialog,
    type IconName,
    OS_OPTIONS,
    SegmentedControl,
    useOsPreference,
} from "@intentic/ui";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { commandShortcut, registerCommand } from "../../../shell/commands/useCommands";
import { badgeClass, badgeText } from "../../../core-views/viewBadge";
import { type SandboxAttentionItem, useSandboxAttention } from "../overview/sandboxAttention";
import { sandboxIdFromToken } from "../client/sandboxIdFromToken";
import { sandboxAvailabilityVisual } from "../overview/availability";
import { attentionByBox, subscribe as watchOtherBoxes } from "../live/fleetAcross";
import { connectedSandboxes, unfinishedSandboxes } from "../live/roster";
import { useSandboxAvailability } from "../overview/useSandboxAvailability";
import { useSandbox } from "../client/useSandbox";
import { useWorkspaceTree } from "../../workspace/explorer/useWorkspaceTree";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";

// Rail control to switch between the user's sandboxes or add another; selecting one re-points every sandbox-backed
// view and the liveness probe at the chosen daemon. Settings, access and everything else about the active sandbox
// live on the tabbed /sandbox hub, opened from here.

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const router = useRouter();
const route = useRoute();
// Everything the sandbox needs from its owner: a badge from `needs`, plus rows for `needs` and `notes`.
const { needs: attention, notes: attentionNotes, badge: attentionBadge } = useSandboxAttention();
const { cmdOs } = useOsPreference();
// One label for the whole control, badge included, since a tooltip on the badge would nest inside this one.
const switcherLabel = computed(() => {
    const name = sandbox.active.value?.name ?? `Sandboxes`;
    const tooltip = attentionBadge.value?.tooltip;
    const status =
        availability.value === `live` || availability.value === `stale` ? undefined : `Sandbox ${availabilityVisual.value.label.toLowerCase()}`;
    return [name, status, tooltip].filter((part) => part !== undefined).join(` · `);
});

// A short retry keeps the healthy dot; changing colour is itself the alarm being avoided.
const connectionDotClass = computed(() => availabilityVisual.value.dotClass);
const connectionLabel = computed(() => availabilityVisual.value.label.toLowerCase());

const ROW_TONE: Record<SandboxAttentionItem["tone"], string> = {
    info: `text-link`,
    warning: `text-warning`,
};

// Anchored rather than PrimeVue's Popover, so one overlay alone decides where a panel goes.
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

// Reads these counts only while the popover is open, since the control is mounted for the whole session; a second
// open within the freshness window paints instantly from the store's last read.
let releaseBoxes: (() => void) | undefined;
watch(open, (showing) => {
    if (showing) {
        releaseBoxes ??= watchOtherBoxes();
        return;
    }
    releaseBoxes?.();
    releaseBoxes = undefined;
});
onUnmounted(() => {
    releaseBoxes?.();
    releaseBoxes = undefined;
});

// A sandbox that never reported in has no daemon, so switching to it can only paint a connecting gate that never
// resolves; those rows are unfinished errands with their own section, not places to switch to.
const switchable = computed(() => connectedSandboxes(sandbox.sandboxes.value));
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value));

// How much is waiting in every other sandbox; absent for the active row since its badge is already on the rail.
// An unanswered box gets undefined, drawn as a dash, never a zero.
const attentionFor = (option: SandboxSummary): number | undefined =>
    option.id === sandbox.activeSandboxId.value ? undefined : attentionByBox.value.get(option.id);

// Whether this row has ever answered, separating "0" from "-"; a single number can't carry both.
const answered = (option: SandboxSummary): boolean => attentionFor(option) !== undefined;

const pick = (option: SandboxSummary): void => {
    open.value = false;
    sandbox.select(option.id);
};

// Every row that goes somewhere is a real link, so Ctrl/⌘-click opens a tab instead of hijacking this one; rows
// that aren't places stay buttons, and a plain click alone closes the popover.
const dismiss = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        open.value = false;
    }
};

// Resumes this row's setup rather than offering a blank create form.
const resumeSetup = (option: SandboxSummary) => ({ path: `/setup`, query: { sandbox: option.id } });

// Alt+1…9 picks the Nth switchable sandbox; a digit past the end does nothing rather than clamping.
const SWITCH_SLOTS = 9;
// Reads the chord from the registry rather than a literal "Alt+N", so a remap or unbind shows correctly.
const slotChord = (at: number): string | undefined => (at < SWITCH_SLOTS ? commandShortcut(`sandbox.switch${at + 1}`) : undefined);

let disposables: readonly Disposable[] = [];

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
    disposables = Array.from({ length: SWITCH_SLOTS }, (_unused, at) =>
        registerCommand({
            owner: `builtin`,
            command: `sandbox.switch${at + 1}`,
            title: `Switch to Sandbox ${at + 1}`,
            icon: `server`,
            keybinding: `Alt+${at + 1}`,
            handler: (): void => {
                // The Nth switchable sandbox, in popover order; unfinished setups are excluded from it.
                const option = switchable.value[at];
                if (option !== undefined) {
                    pick(option);
                }
            },
        }),
    );
});

onUnmounted(() => {
    for (const disposable of disposables) {
        disposable.dispose();
    }
    disposables = [];
});

// The sandbox awaiting removal confirmation; removal is non-destructive, the daemon keeps running.
const pending = ref<SandboxSummary | undefined>(undefined);
const cleanupSlug = ref<string | undefined>(undefined);

// The container slug on the hosting machine: the hostname's first label, or a sha256(token)-derived fallback.
watch(pending, async (target) => {
    // Owner rows only, and an owner's row is the one that carries the token (a member's says null).
    if (target === undefined || target.role !== `owner` || target.token === null) {
        cleanupSlug.value = undefined;
        return;
    }
    if (target.daemonUrl !== null) {
        cleanupSlug.value = new URL(target.daemonUrl).hostname.split(`.`)[0] ?? ``;
        return;
    }
    cleanupSlug.value = sandboxSubdomain(await sandboxIdFromToken(target.token));
});

// Follows the shared OS preference, since the host may be Windows where the POSIX one-liner can't run.
const cleanupCommand = computed(() => {
    const slug = cleanupSlug.value;
    if (slug === undefined) {
        return undefined;
    }
    return cmdOs.value === `windows` ? psCommand(`cleanupPs1`, ``, `-Slug ${slug} -Yes`) : bashCommand(`cleanup`, ``, `${slug} -y`);
});

const askRemove = (option: SandboxSummary): void => {
    open.value = false;
    pending.value = option;
};

const confirmRemove = async (): Promise<void> => {
    const target = pending.value;
    pending.value = undefined;
    if (target === undefined) {
        return;
    }
    const removal = sandbox.remove(target.id);
    // remove() drops the row synchronously before its first await, so the empty check is valid here.
    if (sandbox.sandboxes.value.length === 0) {
        void router.push(`/setup`);
    }
    await removal;
};
</script>

<template>
    <!--
        The rail's top control: a live chip for the active sandbox, click to switch. The corner overlays are siblings,
        not children, since the button's overflow-hidden would clip anything meant to hang past its edge.
    -->
    <span class="relative flex">
        <button
            ref="trigger"
            type="button"
            class="sandbox-switcher flex items-center justify-center overflow-hidden rounded-lg border border-line transition-colors hover:border-line-strong hover:bg-overlay hover:text-content"
            :class="route.path.startsWith('/sandbox') ? 'bg-primary-600/15 text-link' : 'bg-card text-muted'"
            :aria-label="`Switch sandbox: ${switcherLabel}`"
            v-tooltip.right="switcherLabel"
            :aria-expanded="open"
            @click="open = !open"
        >
            <img v-if="sandbox.active.value?.image" :src="sandbox.active.value.image" alt="" class="h-full w-full object-cover" />
            <span v-else-if="sandbox.active.value?.name" class="text-base font-semibold uppercase text-content">{{
                sandbox.active.value.name.charAt(0)
            }}</span>
            <Icon name="server" v-else class="text-lg" />
        </button>
        <!-- One corner badge: a count when the amount is the message, a glyph otherwise; aria-hidden as redundant. -->
        <span
            v-if="attentionBadge"
            class="pointer-events-none absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
            :class="badgeClass(attentionBadge)"
            aria-hidden="true"
        >
            <Icon v-if="attentionBadge.mark !== undefined" :name="attentionBadge.mark as IconName" />
            <template v-else>{{ badgeText(attentionBadge) }}</template>
        </span>
        <span
            class="pointer-events-none absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card"
            :class="connectionDotClass"
        ></span>
    </span>

    <!-- Zeroed padding: PrimeVue's popover padding reads as a frame around rows with their own inset. -->
    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="start">
        <div class="flex w-60 flex-col gap-0.5 p-1">
            <!-- The badge's detail: one row per pending item, routing to the hub tab that resolves it. -->
            <template v-if="attention.length > 0">
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Needs you</div>
                <RouterLink
                    v-for="item in attention"
                    :key="item.message"
                    :to="item.to"
                    class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="dismiss"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center" :class="ROW_TONE[item.tone]">
                        <Icon :name="item.icon" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 text-content">{{ item.message }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </RouterLink>
                <div class="my-1 border-t border-line"></div>
            </template>

            <!-- Things simply true (a contended port, a newer image): found on arrival, not advertised by the badge. -->
            <template v-if="attentionNotes.length > 0">
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Worth knowing</div>
                <RouterLink
                    v-for="item in attentionNotes"
                    :key="item.message"
                    :to="item.to"
                    class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="dismiss"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                        <Icon :name="item.icon" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 text-muted">{{ item.message }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle" />
                </RouterLink>
                <div class="my-1 border-t border-line"></div>
            </template>

            <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Sandboxes</div>

            <button
                v-for="(option, at) in switchable"
                :key="option.id"
                type="button"
                class="group flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors"
                :class="option.id === sandbox.activeSandboxId.value ? 'bg-primary-600/15' : 'hover:bg-content/5'"
                @click="pick(option)"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-card text-muted">
                    <img v-if="option.image" :src="option.image" alt="" class="h-full w-full object-cover" />
                    <Icon name="server" v-else class="text-xs" />
                </span>
                <span class="min-w-0 flex-1 truncate" :class="option.id === sandbox.activeSandboxId.value ? 'text-link' : 'text-content'">{{
                    option.name
                }}</span>
                <span
                    v-if="option.id === sandbox.activeSandboxId.value"
                    class="shrink-0 h-1.5 w-1.5 rounded-full"
                    :class="connectionDotClass"
                    v-tooltip.top="connectionLabel"
                ></span>
                <!-- What's waiting in that sandbox; nothing waiting draws nothing, an unanswered box draws a dash. -->
                <span
                    v-else-if="answered(option) && attentionFor(option)! > 0"
                    class="shrink-0 rounded-full bg-warning/15 px-1.5 py-0.5 text-2xs font-semibold leading-4 text-warning"
                    v-tooltip.top="`${attentionFor(option)} waiting for you in ${option.name}`"
                    >{{ attentionFor(option) }}</span
                >
                <span
                    v-else-if="!answered(option)"
                    class="shrink-0 px-1 text-2xs leading-4 text-subtle"
                    v-tooltip.top="`${option.name} isn't answering, so what's waiting there isn't known`"
                    aria-label="Not answering"
                    >&ndash;</span
                >
                <span v-if="option.role !== 'owner'" class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-medium text-subtle"
                    >Shared</span
                >
                <!-- Which digit this row is, the only place the chord can be learned; fades under the trash icon's hover. -->
                <kbd
                    v-if="slotChord(at)"
                    class="shrink-0 rounded border border-line px-1 font-mono text-2xs font-normal leading-4 text-subtle transition-opacity group-hover:opacity-0"
                    >{{ slotChord(at) }}</kbd
                >
                <Icon
                    name="trash"
                    @click.stop="askRemove(option)"
                    v-tooltip.top="option.role === 'owner' ? 'Remove from account' : 'Leave'"
                    class="shrink-0 text-xs opacity-0 transition-opacity hover:text-danger group-hover:opacity-60"
                />
            </button>

            <RouterLink
                to="/setup"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                    <Icon name="plus" class="text-xs text-muted" />
                </span>
                Add sandbox
            </RouterLink>

            <!--
                Setups that were never finished, as their own section below Add sandbox, since they're errands, not places to
                go; a draft normally never survives to be listed here, so this catches a closed tab or a crash.
            -->
            <template v-if="unfinished.length > 0">
                <div class="my-1 border-t border-line"></div>
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Unfinished setup</div>
                <RouterLink
                    v-for="option in unfinished"
                    :key="option.id"
                    :to="resumeSetup(option)"
                    class="group flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-content/5"
                    @click="dismiss"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center text-subtle">
                        <Icon name="wrench" class="text-xs" />
                    </span>
                    <span class="min-w-0 flex-1 truncate text-muted">Finish setting up {{ option.name }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-2xs text-subtle transition-opacity group-hover:opacity-0" />
                    <!-- In flow, not overlaid, so hovering never shifts the text; `.prevent` stops the anchor firing too. -->
                    <Icon
                        name="trash"
                        @click.prevent.stop="askRemove(option)"
                        v-tooltip.top="option.role === 'owner' ? 'Remove from account' : 'Leave'"
                        class="shrink-0 text-xs opacity-0 transition-opacity hover:text-danger group-hover:opacity-60"
                    />
                </RouterLink>
            </template>

            <div class="my-1 border-t border-line"></div>

            <!-- The sandbox management hub has no rail tile; this chip is its home, and every attention row lands here too. -->
            <RouterLink
                to="/sandbox"
                class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-content transition-colors hover:bg-content/5"
                @click="dismiss"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                    <Icon name="cog" class="text-xs text-muted" />
                </span>
                Sandbox settings
            </RouterLink>
        </div>
    </AnchoredOverlay>

    <ConfirmDialog
        :open="pending !== undefined"
        :header="pending?.role === 'owner' ? 'Remove from account?' : 'Leave sandbox?'"
        :confirm-label="pending?.role === 'owner' ? 'Remove' : 'Leave'"
        confirm-icon="trash"
        @cancel="pending = undefined"
        @confirm="confirmRemove"
    >
        <p v-if="pending" class="text-sm text-content">
            {{
                pending.role === "owner"
                    ? pending.hosted !== null
                        ? `Remove "${pending.name}"? Its hosted machine is destroyed with it: everything on it, including its files, is gone for good.`
                        : `Remove "${pending.name}" from your account? Everyone loses access here; the sandbox itself keeps running wherever it is.`
                    : `Leave "${pending.name}"? You lose access; the sandbox keeps running.`
            }}
        </p>
        <!-- The hosted lane is the only removal that destroys a machine; no cleanup command, since nothing else exists. -->
        <template v-if="pending?.role === 'owner' && pending.hosted === null && cleanupCommand !== undefined">
            <p class="mt-3 text-sm text-muted">To also remove it from the machine hosting it: including its files, run there:</p>
            <SegmentedControl class="mt-2" v-model="cmdOs" :options="OS_OPTIONS" />
            <Code class="mt-1.5" :code="cleanupCommand" :lang="commandLang(cmdOs)" label="Cleanup command" :wrap="true" />
        </template>
    </ConfirmDialog>
</template>

<style scoped>
/* The fallback matches the rail's own sizing, so the chip holds its size across text sizes regardless. */
.sandbox-switcher {
    width: var(--icon-rail-tile-size, calc(2.75rem / var(--ui-scale)));
    height: var(--icon-rail-tile-size, calc(2.75rem / var(--ui-scale)));
}
</style>
