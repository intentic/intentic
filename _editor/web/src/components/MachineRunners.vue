<script setup lang="ts">
import { computed, ref } from "vue";
import type { Computer } from "@intentic/sandbox-contract";
import { Button, ConfirmDialog, MachineRunLog, Notice, type NoticeModel, StatusBadge, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { createRunner, removeRunner, syncRunnerSettings, updateRunner, useRunners } from "../composables/sandbox/useRunners";

/* THIS SANDBOX'S RUNNERS ON ONE COMPUTER: the containers it keeps there to run agents in, listed under the
 * machine that holds them, with the two buttons that make and unmake one (docs/remote-runners-plan.md in the
 * workspace this sandbox serves).
 *
 * SEPARATE FROM THE SANDBOX LIST ABOVE IT, and the distinction is the whole point of the section: those are
 * workspaces belonging to a person, and one of them may be the very box this page is served from; these
 * belong to THIS sandbox, hold no workspace of their own (only a mirror of its git), and exist so a
 * conversation started here can spend that machine's cores instead of these.
 *
 * Only runners this sandbox ASKED FOR appear under a machine: one started by hand with `ic runner up` has no
 * host recorded, so it is listed in the placement picker (it can run turns perfectly well) but has no row
 * here, because this view's rows are buttons, and there is no machine to press them against. */

const { computer } = defineProps<{ computer: Computer }>();

const { runners, refetch } = useRunners();
const mine = computed(() => runners.value.filter((runner) => runner.host !== undefined && runner.host === computer.hostId));

// One flow at a time on one machine, the same rule the sandbox rows above follow.
const busy = ref<string | undefined>();
const lines = ref<string[]>([]);
const failure = ref<NoticeModel | undefined>();
const done = ref<string | undefined>();

const facts = (runner: { online: boolean; facts?: { cpus: number; memoryMb: number; load: number } }): string => {
    if (!runner.online) {
        return `Offline — asleep, or its container is down`;
    }
    return runner.facts === undefined
        ? `Ready`
        : `${runner.facts.cpus} cores · ${Math.round(runner.facts.memoryMb / 1024)} GB · load ${runner.facts.load.toFixed(2)}`;
};

/* PARITY, itemized (the drift lines the daemon computes per runner): what differs and which remedy each line
 * takes. A "Setting …" line is fixable in place over the runner's live link, so it earns the Sync button; an
 * overlay line takes a remove-and-re-add (the rebuild), and the line's own words say so. */
const driftSummary = (runner: { drift?: { subject: string; detail: string }[] }): string | undefined => {
    if (runner.drift === undefined || runner.drift.length === 0) {
        return undefined;
    }
    return `Differs from this sandbox: ${runner.drift.map((line) => line.subject).join(", ")}`;
};
const driftDetail = (runner: { drift?: { subject: string; detail: string }[] }): string =>
    (runner.drift ?? []).map((line) => `${line.subject} — ${line.detail}`).join("\n");
const syncable = (runner: { online: boolean; drift?: { subject: string }[] }): boolean =>
    runner.online && (runner.drift ?? []).some((line) => line.subject.startsWith(`Setting `));

const syncing = ref<string | undefined>();
const sync = async (id: string): Promise<void> => {
    if (syncing.value !== undefined) {
        return;
    }
    syncing.value = id;
    failure.value = undefined;
    try {
        await syncRunnerSettings(id);
    } catch (error) {
        failure.value = noticeFrom(error, `The settings didn't reach that runner.`);
    } finally {
        syncing.value = undefined;
        refetch();
    }
};

/* A NAME THAT READS AS A PLACE. It is what the placement picker shows and what the machine files the
 * container under, so it is asked for rather than generated: "rog" beats "runner-8f3a1c" in a menu you pick
 * from every day. Lowercase letters, digits and dashes, which is what `ic` accepts. */
// A removal parks here until the app's own dialog answers — the browser's confirm() this replaces spoke in
// the wrong voice ("localhost says") and could not separate the question from what survives it (everything).
const confirmingRemove = ref<string | undefined>();
const removeHeader = computed(() => `Remove runner "${confirmingRemove.value ?? ``}"?`);

const run = async (op: "create" | "remove" | "update", name: string): Promise<void> => {
    if (computer.hostId === undefined || busy.value !== undefined) {
        return;
    }
    if (op === "remove") {
        confirmingRemove.value = name;
        return;
    }
    await execute(op, name);
};

const removeConfirmed = async (): Promise<void> => {
    const name = confirmingRemove.value;
    confirmingRemove.value = undefined;
    if (name !== undefined) {
        await execute("remove", name);
    }
};

const execute = async (op: "create" | "remove" | "update", name: string): Promise<void> => {
    if (computer.hostId === undefined || busy.value !== undefined) {
        return;
    }
    busy.value = name;
    failure.value = undefined;
    done.value = undefined;
    lines.value = [];
    try {
        const onLine = (line: string): void => void (lines.value = [...lines.value, line]);
        const flow = { create: createRunner, remove: removeRunner, update: updateRunner }[op];
        done.value = await flow(computer.hostId, name, onLine);
    } catch (error) {
        failure.value = noticeFrom(error, `That didn't work on this computer.`);
    } finally {
        busy.value = undefined;
        refetch();
    }
};

const asked = ref("");
const adding = ref(false);
const nameError = computed(() =>
    asked.value !== "" && !/^[a-z0-9-]+$/.test(asked.value) ? `Lowercase letters, digits and dashes only.` : undefined,
);

const add = async (): Promise<void> => {
    if (asked.value === "" || nameError.value !== undefined) {
        return;
    }
    const name = asked.value;
    asked.value = "";
    adding.value = false;
    await run("create", name);
};
</script>

<template>
    <div v-if="computer.hostId !== undefined" class="border-t border-line-subtle pt-3">
        <div class="flex items-center justify-between gap-2">
            <span class="text-2xs font-semibold uppercase tracking-wide text-subtle">Runners for this sandbox</span>
            <Button
                v-if="!adding"
                size="small"
                severity="secondary"
                :text="true"
                label="Add runner"
                :disabled="busy !== undefined || computer.online !== true"
                @click="adding = true"
            >
                <template #icon><Icon name="plus" /></template>
            </Button>
        </div>

        <p v-if="mine.length === 0 && !adding" class="mt-1 text-2xs text-subtle">
            None here yet. A runner is a container this sandbox keeps on this computer so agents can run on its cores instead of the ones the
            workspace lives on; the work still lands here.
        </p>

        <!-- The name is asked for rather than generated: it is what you pick from in the composer every day. -->
        <div v-if="adding" class="mt-2 flex flex-wrap items-center gap-2">
            <input
                v-model="asked"
                type="text"
                placeholder="a name, e.g. rog"
                :class="ui.input(`w-44 py-1.5`)"
                @keydown.enter.prevent="add()"
                @keydown.esc.prevent="adding = false"
            />
            <Button size="small" label="Create" :disabled="asked === `` || nameError !== undefined" @click="add()" />
            <Button size="small" severity="secondary" :text="true" label="Cancel" @click="adding = false" />
            <span v-if="nameError" class="text-2xs text-danger">{{ nameError }}</span>
        </div>

        <ul v-if="mine.length > 0" class="mt-2 flex flex-col gap-1">
            <li v-for="runner in mine" :key="runner.id" class="flex items-center gap-2 rounded-lg px-2 py-1.5">
                <Icon name="desktop" class="text-xs" :class="runner.online ? 'text-primary-500' : 'text-subtle'" />
                <span class="flex min-w-0 flex-col">
                    <span class="truncate text-xs text-content">{{ runner.id }}</span>
                    <span class="text-2xs text-subtle">{{ facts(runner) }}</span>
                    <!-- Every line's detail rides the title: the row stays one glance, the tooltip is the story. -->
                    <span v-if="driftSummary(runner)" class="truncate text-2xs text-warning" :title="driftDetail(runner)">
                        {{ driftSummary(runner) }}
                    </span>
                </span>
                <StatusBadge v-if="!runner.online" variant="neutral" size="xs" label="offline" />
                <!-- A runner months behind the parent runs turns fine until the day it does not, and then the
                 failure reads as a link error rather than as an old machine. So the drift is said on the row,
                 with the one button that ends it. -->
                <StatusBadge v-else-if="runner.parity === `outdated`" variant="warning" size="xs" label="outdated" />
                <!-- Two remedies, one row: Update rebuilds an outdated container (image/channel/overlay drift);
                 Sync settings pushes the fixable half over the runner's live link. Each shows only when it has
                 something to do. -->
                <span class="ml-auto flex items-center gap-1">
                    <Button
                        v-if="runner.parity === `outdated` && runner.online"
                        size="small"
                        severity="secondary"
                        label="Update"
                        :disabled="busy !== undefined || computer.online !== true"
                        @click="run(`update`, runner.id)"
                    />
                    <Button
                        v-if="syncable(runner)"
                        size="small"
                        severity="secondary"
                        :text="true"
                        :label="syncing === runner.id ? `Syncing…` : `Sync settings`"
                        :disabled="syncing !== undefined || busy !== undefined"
                        @click="sync(runner.id)"
                    />
                    <Button
                        size="small"
                        severity="secondary"
                        :text="true"
                        label="Remove"
                        :disabled="busy !== undefined || computer.online !== true"
                        @click="run(`remove`, runner.id)"
                    />
                </span>
            </li>
        </ul>

        <!-- The machine's own output while `ic` works, and whatever it said at the end. -->
        <MachineRunLog
            v-if="busy !== undefined"
            :lines="lines"
            :running="true"
            empty="Starting on that computer…"
            note="Running on that computer. It keeps going even if you leave this page."
        />
        <Notice v-if="failure" :of="failure" />
        <p v-else-if="done" class="mt-1 text-xs text-muted">{{ done }}</p>

        <ConfirmDialog
            :open="confirmingRemove !== undefined"
            :header="removeHeader"
            confirm-label="Remove"
            confirm-icon="trash"
            @cancel="confirmingRemove = undefined"
            @confirm="removeConfirmed"
        >
            <p>
                The runner comes off {{ computer.label }}. Its work lives in this sandbox's git, so nothing is lost with it — and you can make a new
                one here any time.
            </p>
        </ConfirmDialog>
    </div>
</template>
