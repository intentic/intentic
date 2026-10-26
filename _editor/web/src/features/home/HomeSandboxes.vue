<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { Beacon, SandboxLogo, ui } from "@intentic/ui";
import Icon from "@intentic/ui/icon";
import { useT } from "@intentic/ui/i18n";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useRole } from "../../client/sandbox/useRole";
import { orderedSandboxes, tileAction } from "../../models/home/homeFacts";
import { switchableSandboxes } from "../../models/sandbox/live/roster";
import { useRequestAddSandbox } from "../../models/sandbox/addSandbox";
import { useHomeAttention } from "../../models/home/useHomeAttention";
import { sandboxEntryPath } from "../../models/sandbox/sandboxScreen";
import { useAuth } from "../../client/auth/useAuth";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { signInAt } from "../../lib/routes/signIn";
import { goInside } from "../../lib/routes/homeDetour";
import ViewBadgeChip from "../../workbench/views/ViewBadgeChip.vue";
import type { ViewBadge } from "@intentic/extension-api";
import HomeNoSandbox from "./HomeNoSandbox.vue";

defineOptions({ inheritAttrs: false });
const { phone = false } = defineProps<{ phone?: boolean }>();
const t = useT();
const router = useRouter();
const sandbox = useSandbox();
const { homeOnly } = useRole();
const { user } = useAuth();
// The switcher's own list (roster.ts `switchableSandboxes`), never the account's raw rows: a setup never finished has no
// daemon to open a home conversation on, and a desktop folder window's own row is no sandbox at all.
const boxes = computed(() => orderedSandboxes(switchableSandboxes(sandbox.sandboxes.value)));
// Before the first sandbox the + wears getting started's beacon, a quiet second way to the press the page itself leads
// with (HomeNoSandbox.vue). No coach mark beside it any more: the page says what it would have said, and a popover over
// a page that already asks for the same press is two voices for one thing.
const readings = useHomeAttention();
const badgeOf = (id: string): ViewBadge | undefined => {
    const count = readings.value.get(id)?.needsYou ?? 0;
    return count > 0 ? { count, tooltip: t(`home.sandboxAttention`, { name: boxes.value.find((box) => box.id === id)?.name ?? ``, count }) } : undefined;
};
// The tile of the sandbox whose chat the page shows; on a page of the person's own (settings), none is.
const route = useRoute();
const selected = (id: string): boolean => route.name === `home` && sandbox.activeSandboxId.value === id;
const labelOf = (id: string, name: string): string => t(`home.sandboxAttention`, { name, count: readings.value.get(id)?.needsYou ?? `—` });
// The same add action everywhere: signed in opens the dialog here; signed out returns to it after sign-in.
const add = useRequestAddSandbox();
let last: { id: string; at: number } | undefined;
const choose = (id: string, input: `click` | `enter`): void => {
    const now = Date.now();
    // A home-only guest has no sandbox to enter: its home is the whole of what it reaches there.
    const action = homeOnly.value ? `select` : tileAction(input, last?.id === id, last === undefined ? Infinity : now - last.at);
    last = { id, at: now };
    sandbox.select(id);
    if (action === `enter`) {
        // Into the sandbox, where it was last left: `/` alone is Home itself (lib/routes/firstScreens.ts). Inside for real,
        // even when that was its Models, which a press on Home would otherwise show in place (lib/routes/homeDetour.ts).
        void goInside(() => router.push(sandboxEntryPath(id)));
    } else if (phone) {
        void router.push(`/home/${encodeURIComponent(id)}`);
    } else {
        void router.replace(`/home`);
    }
};
</script>

<template>
    <!-- On a phone, the master view IS this list: a page of its own. -->
    <nav v-if="phone" v-bind="$attrs" :aria-label="t(`home.sandboxes`)" class="flex h-full flex-col gap-3 overflow-y-auto bg-card p-3">
        <div class="flex items-center justify-between gap-2 px-2 py-1">
            <h1 class="py-2 text-lg font-semibold">{{ t(`home.title`) }}</h1>
            <!-- The phone's first screen has no rail, so the account's settings (sign-out included) are reached from here. -->
            <RouterLink
                v-if="user !== null"
                to="/settings"
                class="flex size-11 items-center justify-center rounded-xl text-muted hover:bg-content/5 hover:text-content"
                :aria-label="t(`shared.settings`)"
            >
                <Icon name="cog" aria-hidden="true" />
            </RouterLink>
            <RouterLink v-else :to="signInAt(HOME_PATH)" class="rounded-lg px-3 py-2 text-sm text-link hover:bg-content/5">{{
                t(`home.firstRun.signIn`)
            }}</RouterLink>
        </div>
        <button
            v-for="box in boxes"
            :key="box.id"
            type="button"
            class="relative flex w-full shrink-0 items-center gap-3 rounded-xl p-2 text-left hover:bg-content/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-link"
            :class="{ 'opacity-40': readings.get(box.id)?.unreachable, 'ring-2 ring-link': selected(box.id) }"
            :aria-label="labelOf(box.id, box.name)"
            :aria-current="selected(box.id) ? 'true' : undefined"
            @click="choose(box.id, 'click')"
            @keydown.enter.prevent="choose(box.id, 'enter')"
        >
            <SandboxLogo :size="36" :image="box.image ?? null" :name="box.name" />
            <span class="min-w-0 flex-1 truncate">{{ box.name }}</span>
            <ViewBadgeChip :badge="badgeOf(box.id)" class="text-[0.625rem]" />
        </button>
        <span class="relative flex shrink-0">
            <button
                type="button"
                class="flex min-h-11 flex-1 items-center gap-3 rounded-xl p-2 text-left text-muted hover:bg-content/5 hover:text-content"
                @click="add"
            >
                <span class="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-line-strong">
                    <Icon name="plus" aria-hidden="true" />
                </span>
                <span>{{ t(`sandbox.words.addSandbox`) }}</span>
            </button>
            <Beacon v-if="!boxes.length" size="sm" class="absolute left-9 top-1" />
        </span>
        <HomeNoSandbox v-if="!boxes.length" nested />
    </nav>
    <!-- On a desktop, the tiles of the shell's own rail (ShellDesktop.vue draws the rail around them, account included),
         worn like every other tile: the same size, selection and corner chip. Only what needs you is counted; a quiet box
         wears nothing, and one that has not answered is dimmed rather than counted. -->
    <div v-else v-bind="$attrs" :aria-label="t(`home.sandboxes`)" role="group" class="icon-rail-nav scrollbar-none flex flex-col items-center overflow-y-auto overscroll-contain">
        <button
            v-for="box in boxes"
            :key="box.id"
            type="button"
            class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg"
            :class="{ 'opacity-40': readings.get(box.id)?.unreachable, 'ui-row-select-on': selected(box.id) }"
            :aria-label="labelOf(box.id, box.name)"
            :aria-current="selected(box.id) ? 'true' : undefined"
            v-tooltip.right="{ title: box.name, note: t(`home.doubleClickToEnter`) }"
            @click="choose(box.id, 'click')"
            @keydown.enter.prevent="choose(box.id, 'enter')"
        >
            <SandboxLogo :image="box.image ?? null" :name="box.name" class="rounded-lg" />
            <ViewBadgeChip :badge="badgeOf(box.id)" class="icon-rail-mark absolute right-0.5 top-0.5" />
        </button>
        <span class="relative flex shrink-0">
            <button
                type="button"
                :class="ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`)"
                :aria-label="t(`sandbox.words.addSandbox`)"
                v-tooltip.right="t(`sandbox.words.addSandbox`)"
                @click="add"
            >
                <Icon name="plus" class="icon-rail-glyph" aria-hidden="true" />
            </button>
            <Beacon v-if="!boxes.length" size="sm" class="absolute right-1 top-1" />
        </span>
    </div>
</template>
