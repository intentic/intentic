<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import type { SandboxSummary } from "@intentic-app/api-contract";
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
import { commandShortcut, registerCommand } from "../composables/commands/useCommands";
import { badgeClass, badgeText } from "../core-views/viewBadge";
import { type SandboxAttentionItem, useSandboxAttention } from "../composables/sandbox/sandboxAttention";
import { sandboxIdFromToken } from "../composables/sandbox/sandboxIdFromToken";
import { sandboxAvailabilityVisual } from "../composables/sandbox/availability";
import { attentionByBox, subscribe as watchOtherBoxes } from "../composables/sandbox/fleetAcross";
import { connectedSandboxes, unfinishedSandboxes } from "../composables/sandbox/roster";
import { useSandboxAvailability } from "../composables/sandbox/useSandboxAvailability";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useWorkspaceTree } from "../composables/workspace/useWorkspaceTree";
import { bashCommand, psCommand } from "../environments/scriptCommand";

/* Rail control to switch between the user's sandboxes (owned + shared) or add another. The active sandbox drives
 * the whole workspace (useSandbox): selecting here re-points every sandbox-backed view + the liveness probe at
 * the chosen daemon. Settings, access and everything else about the active sandbox live on the tabbed /sandbox
 * hub (opened from here). */

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const router = useRouter();
const route = useRoute();
/* Everything the sandbox needs from its owner (sandboxAttention): a corner badge on the chip, and one routed row
 * per item inside the popover. The hub behind them has no rail tile, so without this the only way to learn a
 * rebuild is pending would be to go asking, which is the hole the bars above the app used to plug.
 *
 * TWO SECTIONS, because only one of them is an errand. The badge counts `needs` alone, so it clears when the last
 * one is done; `notes` ride along in the popover for the reader who opened it anyway, under a heading that does
 * not claim they are waiting on anybody. */
const { needs: attention, notes: attentionNotes, badge: attentionBadge } = useSandboxAttention();
const { cmdOs } = useOsPreference();
// ONE label for the whole control, badge included: the rail's tileLabel rule. A tooltip on the badge itself
// would open a second box on top of this one (it is a descendant), and the badge is a glyph or a bare number,
// so this string is the only place its sentence exists.
const switcherLabel = computed(() => {
    const name = sandbox.active.value?.name ?? `Sandboxes`;
    const tooltip = attentionBadge.value?.tooltip;
    const status =
        availability.value === `live` || availability.value === `stale` ? undefined : `Sandbox ${availabilityVisual.value.label.toLowerCase()}`;
    return [name, status, tooltip].filter((part) => part !== undefined).join(` · `);
});

// A short retry keeps the healthy dot it had: changing colour is itself the alarm we are avoiding. Only a
// sustained wait or a cause requiring action earns a visible state change.
const connectionDotClass = computed(() => availabilityVisual.value.dotClass);
const connectionLabel = computed(() => availabilityVisual.value.label.toLowerCase());

const ROW_TONE: Record<SandboxAttentionItem["tone"], string> = {
    info: `text-link`,
    warning: `text-warning`,
};

/* Anchored rather than PrimeVue's Popover, so the app has ONE overlay that decides where a panel goes: the
 * one that measures against the window its anchor is in. This chip lives on the rail beside panels that pop
 * out, and two answers to "is there room below?" is how a menu ends up over its own trigger. */
const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);

/* The counts below are read WHILE THIS POPOVER IS OPEN and not a moment longer.
 *
 * This control is mounted for the whole session, so subscribing on mount would poll every sandbox the account
 * owns for as long as the app is up, to keep numbers current on a list nobody has opened. The store keeps what
 * it last read (fleetAcross), so a second open inside its freshness window paints instantly and costs nothing,
 * and the first one fills in within a moment of the list appearing, which is the whole time the reader is
 * looking at it anyway. */
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

/* THE LIST IS TWO LISTS (roster.ts). Switching to a sandbox that has never reported in is not switching to
 * anything: it has no daemon, so the shell can only paint a connecting gate that cannot resolve, so those
 * rows are not offered as places to go. They are unfinished errands, and they get their own section below,
 * under a heading that says what they are and a row that says what clicking does.
 *
 * It used to be one list with a "Setup" chip on those rows, and the chip could not carry the difference: a
 * sandbox you own that is merely offline looked the same as one that has never existed anywhere, and picking
 * the second threw you out of the workspace you were standing in. */
const switchable = computed(() => connectedSandboxes(sandbox.sandboxes.value));
const unfinished = computed(() => unfinishedSandboxes(sandbox.sandboxes.value));

/* HOW MUCH IS WAITING IN THE SANDBOXES THIS ONE IS NOT, one number per row.
 *
 * It answers the question this control could not: the rail's Agents badge is about the box you are in, so work
 * finishing anywhere else was invisible until you happened to go and look. The count for the ACTIVE row is
 * deliberately absent, its badge is already on the rail, and saying it twice on one screen would make the two
 * disagree the moment one of them lagged.
 *
 * A NUMBER, AND ONLY INSIDE THE POPOVER. This is a statistic, and the chip's badge rule (sandboxAttention) is
 * that a statistic must never sit on a permanently visible surface: summed onto the chip it would be lit on
 * any account with a few sandboxes, all day, which is what teaches a reader to stop looking at the one badge
 * that means something. Here it is read by someone who has already opened the list to decide where to go, and
 * a count is exactly what that decision wants.
 *
 * A box that has not answered gets a dash, never a zero: "nothing is waiting for you" is a claim, and a failed
 * read is not evidence for it. */
const attentionFor = (option: SandboxSummary): number | undefined =>
    option.id === sandbox.activeSandboxId.value ? undefined : attentionByBox.value.get(option.id);

// Whether this row has ever been heard from, which is what separates "0" from "-". Split out because the
// template asks both questions about the same row and a single number cannot carry both answers.
const answered = (option: SandboxSummary): boolean => attentionFor(option) !== undefined;

const pick = (option: SandboxSummary): void => {
    open.value = false;
    sandbox.select(option.id);
};

/* EVERY ROW IN THIS POPOVER THAT GOES SOMEWHERE IS A LINK. They were <button>s calling router.push, so twelve
 * ordinary addresses in this app had no href on them: nothing in the status bar on hover, no "Open in new tab"
 * in the browser's own menu, and Ctrl/⌘-click did the one thing it must never do: navigated the tab the user
 * was reading instead of opening another. The rows that are not places (picking a sandbox, removing one) stay
 * buttons, because they are not.
 *
 * The popover closes on the plain click alone (`dismiss`): a modified click is answered by a tab opening
 * somewhere else, and shutting the menu somebody is still working through is not part of that answer. */
const dismiss = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        open.value = false;
    }
};

// Back to the one screen where an unfinished sandbox can become a workspace, resuming THIS row rather than
// offering a blank create form. (The router's requireSetup does the same thing on a cold load with nothing else
// to open; this is the same rule from inside, for an account that also has one that works.)
const resumeSetup = (option: SandboxSummary) => ({ path: `/setup`, query: { sandbox: option.id } });

/* ALT+1…9: the Nth sandbox in this popover's own order, without opening it.
 *
 * Positional rather than a cycle, because a switch re-points every daemon-backed query and the liveness probe
 * at another machine: walking past the one you wanted is not a keystroke you take back, and the list is short
 * enough to aim at directly. A digit past the end therefore does NOTHING: clamping to the last sandbox would
 * answer a miss with the most expensive thing this control can do.
 *
 * Alt, not Mod: every browser owns Mod+1…9 for tab selection and won't hand it over. Digits survive Apple
 * layouts because matchesChord falls back to the PHYSICAL key for the number row (⌥1 produces "¡"), which is
 * the same reason the sibling family can't be Alt+letter.
 *
 * NOT gated on `reachable`: a sandbox that needs attention is the single best reason to be pressing this at
 * all, and the rest of the shell likewise keeps cached navigation available through transient stalls. */
const SWITCH_SLOTS = 9;
// The row's own chord, read back from the registry rather than printed as a literal "Alt+N", so a remap in
// Settings → Keybindings, or an unbind: is what the popover shows. Reactive, like every commandShortcut read.
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
                // The Nth SWITCHABLE sandbox: the same order the popover draws, which is the only order the
                // digit can be learned from. Unfinished setups are not in it: they are not places to switch to,
                // and a chord that bounced you onto /setup would be the worst possible use of one keystroke.
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

// The sandbox awaiting removal confirmation (owner: drops the platform record for everyone; member: leaves).
// Non-destructive either way: the daemon keeps running on its host; teardown is the cleanup script's job,
// so the owner dialog surfaces that command (cleanupCommand) for the machine hosting it.
const pending = ref<SandboxSummary | undefined>(undefined);
const cleanupSlug = ref<string | undefined>(undefined);

// The container slug on the hosting machine: the hostname's first label (sandbox-<id> or a custom subdomain,
// both equal connect.sh's SLUG), or (for a sandbox that never announced a daemonUrl) the same
// sandbox-<sha256(token)[:12]> derivation Setup.vue pre-fills the subdomain with (must mirror the CLI).
watch(pending, async (target) => {
    if (target === undefined || target.role !== `owner`) {
        cleanupSlug.value = undefined;
        return;
    }
    if (target.daemonUrl !== null) {
        cleanupSlug.value = new URL(target.daemonUrl).hostname.split(`.`)[0] ?? ``;
        return;
    }
    cleanupSlug.value = sandboxSubdomain(await sandboxIdFromToken(target.token));
});

// The host may be a Windows PC (the /setup command has a PowerShell lane, so it can be), where the POSIX
// one-liner is unrunnable, so the teardown follows the same shared Linux/Windows preference every other
// command surface uses. cleanup.ps1 takes PowerShell parameters, not cleanup.sh's positional slug + -y.
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
    <!-- The rail's top control: a live chip for the active sandbox (initial + online status), click to switch.
         The corner overlays are siblings of the button, not children: the button clips (overflow-hidden is what
         crops a custom image to the tile's rounded square), so an overlay inside it loses whatever hangs past
         the edge, and both of these are meant to hang past it. The wrapper carries the positioning context;
         pointer-events-none keeps them from stealing the click that opens the switcher. -->
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
        <!-- What the sandbox needs from its owner, as one corner badge: the head item's count where the amount
             is the message, its glyph otherwise. aria-hidden because the button's own label already says every
             pending sentence in words: a bare number read out of context tells a screen reader nothing. -->
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

    <!-- The panel's own inset is the menu's, not the theme's: PrimeVue's popover padding is sized for a content
         card, and around rows that already carry px-2 py-1 it reads as a frame. Zeroed so this box insets like
         every other menu in the app (ContextMenu's rootList): 4px here, 12px from edge to label. -->
    <AnchoredOverlay v-model="open" :anchor="trigger ?? undefined" side="right" cross="start">
        <div class="flex w-60 flex-col gap-0.5 p-1">
            <!-- The badge's detail: one row per pending item, each routing to the hub tab that resolves it.
                 First in the popover because the badge is what brought the reader here, and each row is the
                 whole sentence its bar used to shout: said once, where it was asked for. -->
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

            <!-- AND THE THINGS THAT ARE SIMPLY TRUE: a contended port, a newer image. Same rows, same
                 destinations, under a heading that promises nothing: none of these brought the reader here (they
                 do not badge the chip), so they are what is found on arrival rather than what was advertised.
                 Second, because a debt that IS waiting must not be read past to get to them. -->
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
                <!-- WHAT IS WAITING IN THAT SANDBOX. Only on rows that are not the active one (see attentionFor),
                     and only ever a count of agents that need somebody: a box with nothing waiting draws nothing
                     at all, so the row stays quiet in the ordinary case and the numbers that do appear are the
                     ones worth crossing to. A box that has not answered says so with a dash rather than a 0. -->
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
                <!-- WHICH DIGIT THIS ROW IS. A positional shortcut nobody can see the positions of is not a
                     shortcut: the chord is invisible everywhere else (there is no menu row for "sandbox 3"),
                     so this list is the only place it can be learned. Fades out under the hover that brings in
                     the trash icon, which needs the same corner. -->
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

            <!-- SETUPS THAT WERE NEVER FINISHED: a section, not rows in the list above, because they are not
                 places to go. Each one is an errand with one move left in it, so the row says the move ("Finish
                 setting up") rather than naming a machine that does not exist yet, and it sits BELOW "Add
                 sandbox": the reader came here to switch or to add, and neither of those may be read past to
                 reach an aside.
                 A draft normally never survives to be listed here: leaving setup without committing throws it
                 away (Setup.vue's discardDraft). This catches the ones no exit hook can: a closed tab, a crash,
                 a machine that was genuinely started and then never came up. -->
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
                    <!-- In flow, not overlaid, same trick as the rows above: both icons always hold their slot
                         and only their opacity changes, so hovering a row never shifts the text beside it.
                         `.prevent` as well as `.stop` now the row is an anchor: without it the trash would
                         still follow the link it sits inside on its way to opening the dialog. -->
                    <Icon
                        name="trash"
                        @click.prevent.stop="askRemove(option)"
                        v-tooltip.top="option.role === 'owner' ? 'Remove from account' : 'Leave'"
                        class="shrink-0 text-xs opacity-0 transition-opacity hover:text-danger group-hover:opacity-60"
                    />
                </RouterLink>
            </template>

            <div class="my-1 border-t border-line"></div>

            <!-- The sandbox management hub has no rail tile: this chip is its home (identity → tabbed settings
                 surface), and it is where every attention row above lands too: each names a tab of the same hub. -->
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
        <!-- The hosted lane is the ONE removal that destroys a machine, because it is the one machine the
             platform runs: the headline above already says so, and there is deliberately no cleanup command
             or console pointer to offer: there is nowhere the machine keeps existing. -->
        <template v-if="pending?.role === 'owner' && pending.hosted === null && cleanupCommand !== undefined">
            <p class="mt-3 text-sm text-muted">To also remove it from the machine hosting it: including its files, run there:</p>
            <SegmentedControl class="mt-2" v-model="cmdOs" :options="OS_OPTIONS" />
            <Code class="mt-1.5" :code="cleanupCommand" :lang="commandLang(cmdOs)" label="Cleanup command" :wrap="true" />
        </template>
    </ConfirmDialog>
</template>

<style scoped>
/* The fallback matches the rail's own arithmetic (ShellDesktop): outside the desktop shell there is no rail to
 * belong to, but the chip is still chrome, so it holds its size across text sizes rather than growing. */
.sandbox-switcher {
    width: var(--icon-rail-tile-size, calc(2.75rem / var(--ui-scale)));
    height: var(--icon-rail-tile-size, calc(2.75rem / var(--ui-scale)));
}
</style>
