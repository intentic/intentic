<script setup lang="ts">
import { ui, Icon, Popover, vAction } from "@intentic/extension-ui";
import { ref } from "vue";
import { host } from "./host";
import { panelSessionOf, type useTargets } from "./useTargets";

/* ONE REPO'S DEV SERVER, on the heading of the list its stories are in.
 *
 * This used to be a card inside the run dialog, repeated once per story GROUP, so a monorepo with six groups
 * showed six ~100px cards that all said "Dev server isn't running" about the same single process, and the run
 * button sat below all of them. The daemon runs ONE dev server per repository, so the honest place for it is the
 * repository's heading, once, at one line.
 *
 * IT IS AMBIENT, not part of composing a run: "is the app up?" is worth knowing while you are writing stories
 * against it, and a state that only appears when you are already committed to a run is a state you find out about
 * too late. The whole chip is the control: clicking it opens the server's terminal, which is the only place a
 * boot is legible (a first start runs an install and can take minutes, and a failed one has nowhere else to show).
 *
 * THE TERMINAL IT OPENS IS THE ONE ACTUALLY SERVING, not the one a Start would have made. Green here means
 * "something is answering", deliberately including a dev server nobody here started, so the terminal was
 * offered for `panel-<repo>`, a session that in that case has never existed, and the panel opened onto an empty
 * strip. Each address now carries the session it is served from (the daemon walks the listening socket's
 * process up to its pane), and an address with none SAYS so instead of offering a button that does nothing.
 *
 * THE CONTROL NEVER DISAPPEARS. `Start` used to be gated on `!running` and vanished the instant the process
 * spawned, leaving a surface that looked like nothing had happened while the port was still a 502. Start now
 * BECOMES "Starting…" and then the address, because those are the three things that can be true.
 *
 * ONE REPO IS NOT ALWAYS ONE ADDRESS. A monorepo whose `dev` script fans a turbo run out across its packages
 * serves several, and the heading shows the count with the list a click away: each row named by the package that
 * bound it, because `_editor/web` against `_site/site` is the only thing that tells three localhost ports apart.
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

    <!-- THE ONE FAILURE IN THESE PACKS THAT IS NOT A <Notice>, and deliberately so. Every other hand-rolled
         alert strip is that component now; this is a CHIP: it sits inline in a row of addresses, truncates to
         whatever width is left, and carries its full text in a tooltip. A notice box is a block that owns its
         line, which is the opposite of what this row needs. It borrows the danger tint, not the shape, and it
         spells that tint out rather than sharing a recipe with the box, because a shared recipe is exactly how
         thirty-two views ended up drawing a notice that was not one. -->
    <span v-else-if="failure" class="truncate rounded-lg border border-danger/40 bg-danger/10 px-2 py-0.5 text-2xs text-danger" :title="failure">{{
        failure
    }}</span>

    <!-- READY, SERVING ONE THING, FROM A TERMINAL. The address is the label: the one fact worth checking at a
         glance, and it is that terminal's trigger rather than sitting beside a second button for it. -->
    <button
        v-else-if="targets.terminalOf(repo) !== undefined"
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`Open the terminal serving this: ${targets.terminalOf(repo)}`"
        @click="host().terminal.open(targets.terminalOf(repo) ?? ``)"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        <span class="font-mono">{{ targets.localUrl(repo) }}</span>
        <Icon name="desktop" class="text-subtle" />
    </button>

    <!-- READY, SERVING ONE THING THIS SANDBOX DOESN'T OWN. Same address, no terminal to open, so the click goes
         to the popover, which is where "then where IS it running" gets an answer. -->
    <button
        v-else-if="targets.localUrl(repo) !== undefined"
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`What this repository is serving`"
        @click="popover?.toggle($event)"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        <span class="font-mono">{{ targets.localUrl(repo) }}</span>
        <Icon name="chevron-down" class="text-subtle" />
    </button>

    <!-- READY, SERVING SEVERAL. A count, because three addresses across a heading is a wall nobody reads; the
         list is one click away and names each by its package. -->
    <button
        v-else-if="targets.stateOf(repo) === `ready`"
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`What this repository is serving`"
        @click="popover?.toggle($event)"
    >
        <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
        {{ targets.serversOf(repo).length }} servers
        <Icon name="chevron-down" class="text-subtle" />
    </button>

    <!-- STARTING. Where Start used to vanish, and where the output lives. The panel's own session is the right
         one here by construction: `starting` means the DAEMON spawned it and nothing has bound a port yet. -->
    <button
        v-else-if="targets.stateOf(repo) === `starting`"
        type="button"
        :class="ui.linkButton(`gap-1.5 text-2xs text-muted hover:text-content hover:no-underline`)"
        v-tooltip.bottom="`A first start installs dependencies, which can take a minute: watch it in the terminal`"
        @click="host().terminal.open(panelSessionOf(repo))"
    >
        <Icon name="spinner" class="shrink-0 animate-spin text-subtle" />
        Starting…
        <Icon name="desktop" class="text-subtle" />
    </button>

    <button
        v-else
        type="button"
        :disabled="starting"
        :class="ui.linkButton(`gap-1.5 text-2xs hover:no-underline`, blocked ? `text-warning hover:text-warning` : `text-muted hover:text-content`)"
        v-tooltip.bottom="`Start this repository's dev server`"
        v-action="start"
    >
        <Icon name="play" class="shrink-0" />
        Start dev server
    </button>

    <!-- WHAT IS OCCUPYING THESE PORTS, one row each: the address, the package that bound it, and the terminal it
         is running in. That last column is the difference between a list you read and a list you can act on:
         every row either opens the output it is producing, or says plainly that this sandbox has none to show. -->
    <Popover ref="popover">
        <div class="flex w-pop-sm flex-col gap-2 p-1">
            <p class="text-sm font-medium text-content">
                <span class="font-mono">{{ repo }}</span> is serving {{ targets.serversOf(repo).length }}
                {{ targets.serversOf(repo).length === 1 ? `app` : `apps` }}
            </p>
            <div v-for="server in targets.serversOf(repo)" :key="server.url" class="flex items-baseline gap-2">
                <span class="h-1.5 w-1.5 shrink-0 -translate-y-0.5 rounded-full bg-success" />
                <span class="font-mono text-2xs text-content">{{ server.url }}</span>
                <span class="ml-auto flex shrink-0 items-baseline gap-2">
                    <span v-if="server.dir" class="font-mono text-2xs text-subtle">{{ server.dir }}</span>
                    <button
                        v-if="server.session"
                        type="button"
                        :class="ui.linkButton(`gap-1 text-2xs text-muted hover:text-content hover:no-underline`)"
                        v-tooltip.bottom="`Open ${server.session}: the terminal this is running in`"
                        @click="host().terminal.open(server.session)"
                    >
                        <Icon name="desktop" class="shrink-0" />
                        {{ server.session }}
                    </button>
                    <span
                        v-else
                        class="text-2xs text-subtle"
                        v-tooltip.bottom="
                            `Nothing in this sandbox's terminals is serving it: it answers from outside them, so there is no output to show here and no session to stop.`
                        "
                    >
                        no terminal
                    </span>
                </span>
            </div>
            <!-- Said here because this is where the count is read, and the remedy is one row down: with several
                 apps behind one `pnpm dev` nothing but the story tree knows which app a group belongs to. -->
            <p v-if="targets.serversOf(repo).length > 1" class="text-2xs text-subtle">
                Each group below says which of these its stories are walked against: the dev server is shared, the addresses are not.
            </p>
        </div>
    </Popover>
</template>
