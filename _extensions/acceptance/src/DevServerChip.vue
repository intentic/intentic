<script setup lang="ts">
import { cmp, Icon, Popover } from "@intentic/extension-ui";
import { ref } from "vue";
import type { useTargets } from "./useTargets";

/* ONE REPO'S DEV SERVER, on the heading of the list its stories are in.
 *
 * This used to be a card inside the run dialog, repeated once per story GROUP — so a monorepo with six groups
 * showed six ~100px cards that all said "Dev server isn't running" about the same single process, and the run
 * button sat below all of them. The daemon runs ONE dev server per repository, so the honest place for it is the
 * repository's heading, once, at one line.
 *
 * IT IS AMBIENT, not part of composing a run: "is the app up?" is worth knowing while you are writing stories
 * against it, and a state that only appears when you are already committed to a run is a state you find out about
 * too late. The whole chip is the control — clicking it opens the server's terminal, which is the only place a
 * boot is legible (a first start runs an install and can take minutes, and a failed one has nowhere else to show).
 *
 * THE CONTROL NEVER DISAPPEARS. `Start` used to be gated on `!running` and vanished the instant the process
 * spawned, leaving a surface that looked like nothing had happened while the port was still a 502. Start now
 * BECOMES "Starting…" and then the address, because those are the three things that can be true.
 *
 * ONE REPO IS NOT ALWAYS ONE ADDRESS. A monorepo whose `dev` script fans a turbo run out across its packages
 * serves several, and the heading shows the count with the list a click away — each row named by the package that
 * bound it, because `_apps/web` against `_apps/site` is the only thing that tells three localhost ports apart.
 * The heading deliberately does not pick one: which app a group's stories belong to is the group's own fact, and
 * it says so on its own row. */

const { repo, targets, blocked } = defineProps<{
    repo: string;
    targets: ReturnType<typeof useTargets>;
    // A selected group is stuck waiting on this server. Tints the chip so the header's note points at something
    // findable instead of naming a repo and leaving you to hunt for it.
    blocked?: boolean;
}>();

const starting = ref(false);
const failure = ref<string | undefined>(undefined);
const popover = ref<InstanceType<typeof Popover> | null>(null);

const start = async (): Promise<void> => {
    starting.value = true;
    failure.value = undefined;
    try {
        await targets.startPanel(repo);
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        starting.value = false;
    }
};
</script>

<template>
    <!-- A repo the daemon runs nothing for says so rather than showing an inert dot: it is why every group below
         carries a typed address, and silence here would read as "not started yet". -->
    <span v-if="targets.stateOf(repo) === `none`" class="text-2xs text-subtle">no dev server</span>

    <span v-else-if="failure" :class="[cmp.alertDanger(`px-2 py-0.5 text-2xs`), `truncate`]" :title="failure">{{ failure }}</span>

    <!-- READY, SERVING ONE THING. The address is the label — the one fact worth checking at a glance — and it is
         the terminal's trigger rather than sitting beside a second button for it. -->
    <button
        v-else-if="targets.localUrl(repo) !== undefined"
        type="button"
        :class="cmp.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`Open the dev server's terminal`"
        @click="targets.showLog(repo)"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        <span class="font-mono">{{ targets.localUrl(repo) }}</span>
        <Icon name="desktop" class="text-subtle" />
    </button>

    <!-- READY, SERVING SEVERAL. A count, because three addresses across a heading is a wall nobody reads; the
         list is one click away and names each by its package. -->
    <button
        v-else-if="targets.stateOf(repo) === `ready`"
        type="button"
        :class="cmp.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`What this repository is serving`"
        @click="popover?.toggle($event)"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        {{ targets.serversOf(repo).length }} servers
        <Icon name="chevron-down" class="text-subtle" />
    </button>

    <!-- STARTING. Where Start used to vanish, and where the output lives. -->
    <button
        v-else-if="targets.stateOf(repo) === `starting`"
        type="button"
        :class="cmp.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`A first start installs dependencies, which can take a minute — watch it in the terminal`"
        @click="targets.showLog(repo)"
    >
        <Icon name="spinner" class="shrink-0 animate-spin text-subtle" />
        Starting…
        <Icon name="desktop" class="text-subtle" />
    </button>

    <button
        v-else
        type="button"
        :disabled="starting"
        :class="cmp.linkButton(`gap-1.5 text-2xs hover:no-underline`, blocked ? `text-warning hover:text-warning` : `text-muted hover:text-content`)"
        v-tooltip.bottom="`Start this repository's dev server`"
        @click="start"
    >
        <Icon name="play" class="shrink-0" />
        Start dev server
    </button>

    <Popover ref="popover">
        <div class="flex w-96 flex-col gap-2 p-1">
            <p class="text-sm font-medium text-content">
                <span class="font-mono">{{ repo }}</span> is serving {{ targets.serversOf(repo).length }} apps
            </p>
            <div v-for="server in targets.serversOf(repo)" :key="server.url" class="flex items-baseline gap-2">
                <span class="h-1.5 w-1.5 shrink-0 translate-y-[-2px] rounded-full bg-success" />
                <span class="font-mono text-2xs text-content">{{ server.url }}</span>
                <span v-if="server.dir" class="ml-auto font-mono text-2xs text-subtle">{{ server.dir }}</span>
            </div>
            <!-- Said here because this is where the count is read, and the remedy is one row down: with several
                 apps behind one `pnpm dev` nothing but the story tree knows which app a group belongs to. -->
            <p class="text-2xs text-subtle">
                Each group below says which of these its stories are walked against — the dev server is shared, the addresses are not.
            </p>
            <button :class="cmp.linkButton(`gap-1.5 text-2xs text-muted hover:text-content`)" type="button" @click="targets.showLog(repo)">
                <Icon name="desktop" class="shrink-0" />
                Open the dev server's terminal
            </button>
        </div>
    </Popover>
</template>
