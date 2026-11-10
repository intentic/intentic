<script setup lang="ts">
import TourMark from "../../tour/TourMark.vue";
import type { SandboxSummary } from "@intentic/api-contract";
import type { ViewBadge } from "@intentic/extension-api";
import { SandboxLogo, type TipTone, type TooltipValue } from "@intentic/ui";
import { localPath } from "@intentic/sandbox-contract/app-routes";
import { computed, type ComputedRef, onMounted, unref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ViewBadgeChip from "../../../workbench/views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../../../workbench/views/viewBadge";
import TileMark from "../../../components/TileMark.vue";
import { restartRunning } from "../../../models/sandbox/live/sandboxRestart";
import { GUEST_SECTION } from "../../../models/sandbox/sandboxNav";
import { sandboxEntryPath } from "../../../models/sandbox/sandboxScreen";
import { hereIn, isPage, page } from "../../../lib/routes/links";
import { sandboxAvailabilityVisual } from "../overview/availability";
import type { SandboxPlacement } from "../overview/placement";
import { rowPlacement, useSandboxPlacement } from "../overview/useSandboxPlacement";
import { arrangedSandboxes, sandboxOrder } from "../../../models/home/sandboxOrder";
import { useSandboxAvailability } from "../overview/useSandboxAvailability";
import { SANDBOX_LIST_KEY, useSandbox } from "../../../client/sandbox/useSandbox";
import { queryClient } from "../../../lib/queryPersistence";
import { rememberedAccount } from "../../../client/directory/deviceDirectory";
import { useWorkspaceTree } from "../../../models/workspace/tree/useWorkspaceTree";
import { announceDesktopRoster, desktopApp, openThisComputer } from "../../../app/environments/desktop";
import { localFace } from "../../../app/environments/local";
import { localHost } from "../../../app/environments/localHost";
import { useAuth } from "../../../client/auth/useAuth";
import { useFolderPlace } from "./switcherPlace";
import { useSwitchCommands } from "./useSwitchCommands";
import { useT } from "@intentic/ui/i18n";

// The rail's top tile, shared by the workspace and the desktop app's local windows, and a plain door in both: no panel
// opens from it. Switching is the cluster under it (OtherSandboxes.vue, which also carries the add tile while there is no
// other sandbox), which unrolls the rail onto every sandbox, and Alt+1…9.
// In the workspace its tooltip says which sandbox this is and where it runs, and a press opens that sandbox's settings.
// In a local window it is This computer, the place that window shows, and a press opens This computer's own page (the
// view the app marks for it, Devices: the machine, its engine and the sandboxes it runs), lit there and wearing that
// page's marks, as the sandbox's logo opens its settings. Until 2026-11-10 the local logo raised the list of the
// account's sandboxes on hover, a second way of switching only one of the two windows had (the owner: "no menu on hover
// of This computer's logo").
// Setup/news/action badges belong to gettingStarted/SandboxErrands.vue, leaving this tile focused on the place.

const t = useT();

const sandbox = useSandbox();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const router = useRouter();
const route = useRoute();
// WORK THAT ENDS BY REPLACING THIS SANDBOX, while it is still running. Not on the attention badge (now on the
// getting-started ring), which counts what the sandbox needs from its owner: this needs nothing, interrupts nothing yet, and is over in minutes — a standing
// badge for it would teach the reader to stop reading the badge. A mark of its own, on its own corner, saying only
// that something is moving. What it will do is said when it does it, by the lane.
const restarting = computed(() => restartRunning(sandbox.activeSandboxId.value));

// WHERE THIS SANDBOX RUNS: Intentic's cloud, a machine of the owner's, or somebody else's. Drawn as one mark with the
// connection's state — the glyph says which machine, its ink says whether that machine answers — because both are
// facts about the same link and two corners saying it was twice the tile for one sentence. That sentence rides the
// control's own label, because a glyph alone cannot be the only place a reader can learn this.
// A local window stands on a folder, not a sandbox, and its sidecar has no device registry to ask, so it reads none.
const placement: ComputedRef<SandboxPlacement | undefined> = localFace() === undefined ? useSandboxPlacement() : computed(() => undefined);

// One label for the whole control, its marks included, since a tooltip on a mark would nest inside this one.
const switcherLabel = computed(() => {
    const name = sandbox.active.value?.name ?? t(`sandbox.sandboxSwitcher.sandboxes`);
    const status =
        availability.value === `live` || availability.value === `stale`
            ? undefined
            : t(`sandbox.sandboxSwitcher.sandboxState`, { state: availabilityVisual.value.label.toLowerCase() });
    return [name, placement.value?.detail, status, restarting.value].filter((part) => part !== undefined).join(` · `);
});

// A short retry keeps the healthy ink; changing colour is itself the alarm being avoided.
const connectionInkClass = computed(() => availabilityVisual.value.inkClass);

// The local window's own half (switcherPlace.ts): opening a sandbox through the app, its sandboxes' order.
const { local, openFromFolder, arranged } = useFolderPlace();

// A sandbox that never reported in has no daemon, so switching to it can only paint a connecting gate that never
// resolves; those rows are unfinished errands on the getting-started ring, not places to switch to.
// A local window's own folder is in the list too (it is the "sandbox" that window shows) and is not a place to switch to.
// Both rules are roster.ts `switchableSandboxes`, in the reader's own order (sandboxOrder.ts `arrangedSandboxes`), the
// one list Home's rail and the phone's menu draw as well, so a sandbox's place and its Alt digit match its tile's. A local
// window keeps no order of its own (its page is another origin, whose storage never saw Home's drag): it wears the
// order the workspace last told the app (switcherPlace.ts `arranged`).
const switchable = computed(() => arrangedSandboxes(sandbox.sandboxes.value, local ? arranged.value : sandboxOrder.value));

// The ACTIVE row borrows the refined placement above rather than deriving its own: the tile and what the app's local
// windows are told of it are the same sandbox, and a glyph that changed between them would read as two answers.
const placementFor = (option: SandboxSummary): SandboxPlacement =>
    option.id === sandbox.activeSandboxId.value && placement.value !== undefined ? placement.value : rowPlacement(option);

// THE LOGO, IN THE WORKSPACE: a door to this sandbox's settings (the tile already lights up on that page). Its tooltip is
// just the cog's own word.
const settingsHere = (): void => {
    const active = sandbox.active.value;
    if (active !== undefined) {
        void router.push(hereIn(active.id, page.sandboxSettings(active.role === `guest` ? GUEST_SECTION : undefined)));
    }
};
const doorLabel = computed(() =>
    t(`sandbox.sandboxSwitcher.settingsOf`, { name: sandbox.active.value?.name ?? t(`sandbox.sandboxSwitcher.sandboxes`) }) +
    switcherLabel.value.slice((sandbox.active.value?.name ?? t(`sandbox.sandboxSwitcher.sandboxes`)).length),
);

// THE LOGO, IN A LOCAL WINDOW: This computer, a door to its own page (the view the app marks `logo`, Devices), which has
// no tile of its own on the rail, so the logo wears what that tile would: its corner for news, its running mark. A
// window with no such view (a page with no app behind it) opens the folder instead.
const logoView = local ? localHost().views.find((view) => view.logo === true) : undefined;
const logoPath = logoView === undefined ? localPath(`files`) : `/${logoView.path}`;
const logoLit = computed(() => local && (route.path === logoPath || route.path.startsWith(`${logoPath}/`)));
const logoBadge = computed<ViewBadge | undefined>(() => unref(logoView?.badge));
const badgeTone = (tone: ViewBadge[`tone`]): TipTone | undefined => (tone === `warning` ? `warning` : tone === `danger` ? `danger` : undefined);
const logoNote = computed(() =>
    [logoView?.title(), logoBadge.value?.tooltip, logoBadge.value?.running].filter((part) => part !== undefined && part !== ``).join(` · `),
);
const logoLabel = computed(() => [t(`sandbox.sandboxSwitcher.thisComputer`), logoNote.value].filter((part) => part !== ``).join(` · `));
const logoTip = computed<TooltipValue>(() => ({
    title: t(`sandbox.sandboxSwitcher.thisComputer`),
    tone: badgeTone(logoBadge.value?.tone),
    note: logoNote.value,
}));
const openLogo = (): void => {
    if (!logoLit.value) {
        void router.push(logoPath);
    }
};

// A pick is a navigation into the sandbox, where it was last left: its address names it, which selects it
// (router/shellGates.ts), and Back undoes the switch. A local window opens the workspace on it through the app.
const pick = (option: SandboxSummary): void => {
    if (local) {
        void openFromFolder(option.id);
        return;
    }
    void router.push(sandboxEntryPath(option.id));
};

// THIS COMPUTER, the desktop app's other face: its own window on a folder of this computer, with This device beside it
// (the app's local shell). The app swaps the two in one frame. An app older than the local shell opens its own card for
// the same link, which is this computer too. A place of the same rank as the sandboxes (2026-11-10, the owner: switching
// between the two must feel like switching sandboxes): first on the unrolled rail in both faces, and on Alt+0 in the
// workspace. Not in the account menu, where it sat for four days (2026-11-06) and switching meant hunting at the other
// end of the rail.
const inDesktopApp = desktopApp() !== undefined && !local;

// The app's local windows list these same sandboxes on their own rail and show this account at their rail's foot,
// and can learn either only from this page (desktop.ts `announceDesktopRoster`): told on mount and again whenever a
// row, its mark or the account changes.
// (2026-11-09) Each row carries the logo thumbnail this device remembers (client/directory/logoThumbnail.ts), and a list
// the platform never gave is not told as an empty one: a cold load whose list failed has no rows yet, which the app
// would otherwise take for an account with none left (setup_link.rs keeps its rows for an empty list too).
const { user } = useAuth();
if (inDesktopApp) {
    const rememberedLogo = (id: string): string | undefined => {
        const email = user.value?.email;
        const image = email === undefined ? undefined : rememberedAccount(email)?.sandboxes.find((entry) => entry.id === id)?.image;
        return image ?? undefined;
    };
    watch(
        () =>
            [
                switchable.value.map((option) => {
                    const image = rememberedLogo(option.id);
                    const row = { id: option.id, name: option.name, place: placementFor(option).kind, shared: option.role !== `owner` };
                    return image === undefined ? row : { ...row, image };
                }),
                user.value === null ? undefined : { email: user.value.email, name: user.value.name, image: user.value.image },
            ] as const,
        ([rows, account]) => {
            const listed = queryClient.getQueryState(SANDBOX_LIST_KEY)?.status === `success`;
            if (rows.length === 0 && account !== undefined && !listed) {
                return;
            }
            announceDesktopRoster(rows, account);
        },
        { immediate: true },
    );
}

// A local window asks for its list itself (switcherPlace.ts).
onMounted(() => {
    if (!local && sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

// Alt+0 for this computer inside the app, Alt+1…9 for the sandboxes under it (useSwitchCommands.ts).
useSwitchCommands(switchable, pick, inDesktopApp ? openThisComputer : undefined);
</script>

<template>
    <!-- The rail's top control, a door in both windows: the active sandbox's settings in the workspace, This computer's
         own page in a local window. -->
    <span class="relative flex">
        <button
            v-if="local"
            type="button"
            data-rail-key="place:this-computer"
            class="sandbox-switcher icon-rail-tile ui-row-select ui-row-select-horizontal flex items-center justify-center overflow-hidden rounded-lg"
            :class="logoLit ? 'ui-row-select-on text-link' : 'text-muted hover:text-content'"
            :aria-label="logoLabel"
            :aria-current="logoLit ? 'page' : undefined"
            v-tooltip.right="logoTip"
            @click="openLogo"
        >
            <!-- This computer has one mark, whichever folder the local window shows. -->
            <Icon name="desktop" class="icon-rail-glyph" aria-hidden="true" />
        </button>
        <button
            v-else
            type="button"
            :data-rail-key="sandbox.activeSandboxId.value === undefined ? undefined : `sandbox:${sandbox.activeSandboxId.value}`"
            class="sandbox-switcher icon-rail-tile ui-row-select ui-row-select-horizontal flex items-center justify-center overflow-hidden rounded-lg"
            :class="isPage(route, `sandboxSettings`) ? 'ui-row-select-on text-link' : 'text-muted hover:text-content'"
            :aria-label="doorLabel"
            v-tooltip.right="t(`shared.settings`)"
            @click="settingsHere()"
        >
            <span class="flex size-full items-center justify-center overflow-hidden rounded-md [&_span]:text-inherit">
                <SandboxLogo :image="sandbox.active.value?.image ?? null" :name="sandbox.active.value?.name" />
            </span>
        </button>
        <!-- WHERE IT RUNS AND WHETHER IT ANSWERS, on the bottom-left corner: bottom-right is where every icon on the
             rail shows its running mark, so that corner belongs to the spinner below. The glyph
             is the machine, its ink the connection: quiet whenever the answer is neither "online" nor "wrong", so a
             fact that is always true carries an errand's weight only when there is one. A plate, where the running
             mark is a bare glyph: this one sits over whatever picture the owner uploaded, and a glyph alone on a photo
             is unreadable. The plate is the tile's own ground, so it reads as a notch cut into the logo rather than a
             second badge. No active sandbox is no link to report, so the corner stays empty rather than guessing.
             aria-hidden: both sentences are already in the button's label above. -->
        <span
            v-if="placement"
            class="sandbox-switcher-mark pointer-events-none absolute bottom-0.5 left-0.5 inline-flex h-[1.6em] w-[1.6em] items-center justify-center rounded-full bg-[color:var(--ui-tile-ground)] leading-none"
            :class="connectionInkClass"
            aria-hidden="true"
        >
            <!-- Plate and glyph measure as every rail badge does, so the corners weigh the same; only the ink differs. -->
            <Icon :name="placement.icon" class="text-[0.9em]" />
        </span>
        <!-- Getting started's way to connecting a model: the sandbox's own settings start here. Its hint leads to them. -->
        <TourMark v-if="!local" step="models" place="rail" still side="right" class="absolute left-0.5 top-0.5" />
        <!-- This computer's page's news, in the corner every rail tile carries it (the page has no tile of its own). -->
        <ViewBadgeChip v-if="local" :badge="logoBadge" class="sandbox-switcher-mark pointer-events-none absolute right-0.5 top-0.5" />
        <!-- The rail's running mark, on the bottom-right corner as on every other rail icon: it is an errand in flight,
     where the two beside it are standing facts, and the one thing here that must never be crowded. The sentence rides the control's own label,
     since a tooltip on a mark inside a tooltipped button nests inside it. -->
        <TileMark
            v-if="restarting !== undefined || (local && logoBadge?.running !== undefined)"
            name="spinner"
            spin
            :class="[RUNNING_MARK_CLASS, `sandbox-switcher-mark pointer-events-none absolute bottom-0.5 right-0.5`]"
        />
    </span>
</template>

<style scoped>
/* The fallback matches the rail's own sizing, so the chip holds its size across text sizes regardless. */
.sandbox-switcher {
    width: var(--icon-rail-tile-size, calc(2.75rem / var(--ui-scale)));
    height: var(--icon-rail-tile-size, calc(2.75rem / var(--ui-scale)));
}

/* Same reading for the corner badge: the rail's mark size when this sits in the rail, its own copy of the number when it doesn't. */
.sandbox-switcher-mark {
    font-size: var(--icon-rail-mark-size, calc(0.625rem / var(--ui-scale)));
}
</style>
