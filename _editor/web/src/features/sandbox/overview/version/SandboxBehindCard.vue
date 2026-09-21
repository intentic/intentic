<script setup lang="ts">
import { machinesOf } from "@intentic/sandbox-contract";
import { Button, Code, CopyButton, DisclosureRow, Notice, Row, RowGroup, RowNote, StatusBadge } from "@intentic/ui";
import { computed, ref, watchEffect } from "vue";
import {
    appBehind,
    comparedRouteCount,
    daemonBehind,
    daemonDrifted,
    driftedRoutes,
    driftScope,
    missingRoutes,
    unknownDaemonRoutes,
} from "../useDaemonRoutes";
import {
    agreementLine,
    APP_PARTY,
    driftAreas,
    driftedAreas,
    KIND_BADGE,
    KIND_ICON,
    KIND_IMPACT,
    KIND_TAG,
    KIND_TONE,
    sandboxParty,
} from "./driftReport";
import { contractUncompiled, readContractFreshness, uncompiledRoutes } from "../contractFreshness";
import { useEnvironment } from "../../environment/useEnvironment";
import { runSeveringDeviceCommand, useDevices, useHostHolding } from "../../devices/useDevices";
import { useHubWork } from "../../../../shell/hub/hubWork";
import ConnectDeviceHint from "../../devices/ConnectDeviceHint.vue";
import { useT } from "@intentic/ui/i18n";

// Checks the daemon's route surface against this app's contract, not version strings (SandboxUpdateCard); catches
// gaps a version compare misses (dev packages are all 0.0.0). A missing route names the daemon as older; a drifted
// payload only proves disagreement, so the heading never guesses. Non-blocking: an old sandbox keeps working.
//
// WHAT IT DRAWS IS THE TWO PARTIES AND THEN THE EVIDENCE, because "7 routes disagree" named the mechanism and
// nothing a reader could act on: not which two programs are failing to meet, not what goes wrong, not where they
// would see it. The parties are two rows, the fallout is one row per area of the product (driftReport.ts), and the
// dotted route names — the only part that was ever on screen — are now what a chevron opens.

const t = useT();

// Dev gets the reload; a non-dev user is pointed at the update card instead.
const isDev = import.meta.env.DEV;
const { slug, localImage } = useEnvironment();
// Dev daemon runs the bind-mounted working tree, not the image: a reload fixes drift, a rebuild doesn't.
const reloadCommand = computed(() => `sh _sandbox/sandbox/scripts/dev-reload.sh${slug.value === undefined ? `` : ` ${slug.value}`}`);
const reloadPage = (): void => location.reload();

// The environment holding this sandbox's checkout, when it is a connected device: then the reload is a button here
// and the command below is only for a checkout nothing can reach. The checkout, not merely the machine — a PC reports
// this container through its Windows side too, and the reload is a `sh` line in a folder only one side has.
const running = useHostHolding(
    () => slug.value,
    () => localImage.value?.root,
);
const { devices } = useDevices({ poll: false });
const onlineDevices = computed(() => devices.value.filter((device) => device.hostId !== undefined && device.online === true));
// dev-reload.sh is a unix line whatever else is true, so a door that runs one itself is the first choice; a Windows
// door is still offered when it is the only one, since the daemon crosses into that PC's distro from there.
const unixDoors = computed(() => onlineDevices.value.filter((device) => device.platform !== `windows`));
// Which machine runs this sandbox is itself read off the daemon's fleet payload, so a daemon far enough behind to
// disagree about that payload answers "none" — and the one button that fixes it would vanish with the field it was
// gated on, exactly when this card is on screen. A single online machine is not a guess, so it is offered: the reload's
// argv names this sandbox's own slug on the far side, so a machine that doesn't hold it refuses rather than restarting
// something else. Two of them is a guess, and stays the printed command; two doors onto one PC (Windows and a distro
// on it) are one machine, and the distro's door is the one that can run the script.
const hostId = computed(
    () => running.value ?? (machinesOf(onlineDevices.value).length === 1 ? (unixDoors.value[0] ?? onlineDevices.value[0])?.hostId : undefined),
);
const hubWork = useHubWork();
const reloading = ref(false);
const reloaded = ref(false);
const failed = ref<string | undefined>(undefined);
// A refusal (an older container with no checkout recorded, a device with commands switched off) hands the command
// back, since the button has just proved it cannot do this here.
const showCommand = computed(() => hostId.value === undefined || failed.value !== undefined);

const reloadOnDevice = async (): Promise<void> => {
    const id = hostId.value;
    if (id === undefined || reloading.value) {
        return;
    }
    reloading.value = true;
    failed.value = undefined;
    reloaded.value = false;
    const endMark = hubWork.begin(`Reloading the sandbox`);
    try {
        // Undefined is the expected ending: the container being restarted is the one answering this request.
        await runSeveringDeviceCommand(id, `dev-reload`);
        reloaded.value = true;
    } catch (error) {
        failed.value = error instanceof Error ? error.message : String(error);
    } finally {
        reloading.value = false;
        endMark();
    }
};

// Asked only once something already disagrees: with the two sides level there is no cause to explain, and the answer
// costs the dev server a contract load.
watchEffect(() => {
    if (daemonBehind.value || daemonDrifted.value) {
        void readContractFreshness();
    }
});

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

// Each side lacking routes the other has: the two builds forked rather than one trailing the other, so neither "behind"
// nor "out of sync" is true and no single reload is the answer.
const forked = computed(() => daemonBehind.value && appBehind.value);

// Five diagnoses, most specific first. An uncompiled contract explains missing routes and drifted ones alike — the
// compiled copy the sandbox runs simply predates the edit — so it outranks the rest rather than being one more guess
// about which side is older.
const heading = computed(() => {
    if (contractUncompiled.value) {
        return `Sandbox is running an older compiled contract`;
    }
    if (forked.value) {
        return `App and sandbox are on different builds`;
    }
    if (daemonBehind.value) {
        return `Sandbox is behind the app`;
    }
    return driftScope.value === `wholesale` ? `App and sandbox are running different contracts` : `App and sandbox are out of sync`;
});

// Named as its own clause rather than folded into the heading: a newer sandbox than tab is ordinary, and only worth
// saying once something else has proved the two disagree. Never on a fork, which says it better already.
const leaning = computed(() => (appBehind.value && !forked.value && !contractUncompiled.value ? ` This page is older than the sandbox.` : ``));

// WHY, in one sentence, and nothing else: the counts moved into the rows below, where each one sits beside the thing
// it is counting. The partial case is the one this card existed to explain and never did — two builds naming the same
// calls and disagreeing about the fields inside them is what "out of sync" actually means here.
const cause = computed(() => {
    if (contractUncompiled.value) {
        return `The contract has changed since it was last compiled, and the sandbox loads the compiled copy: ${plural(uncompiledRoutes.value.length, `call differs`, `calls differ`)}. Reloading this page won't help.`;
    }
    if (forked.value) {
        return `Each side makes calls the other has never heard of — ${plural(unknownDaemonRoutes.value.length, `call`, `calls`)} in the sandbox's direction — so neither is simply older, and no single reload settles it.`;
    }
    if (daemonBehind.value) {
        return `This sandbox was built before these calls existed, so it can't answer them.`;
    }
    if (driftScope.value === `wholesale`) {
        return `Almost nothing matches: these are two different builds rather than one changed field.${leaning.value}`;
    }
    return `Both sides make the same calls and disagree about the fields inside them.${leaning.value}`;
});

// Which machine the daemon is actually on, said only when this app is sure of it: the fallback `hostId` above is a
// one-device guess, good enough to aim a reload at and not good enough to state as a fact.
const parties = computed(() => [APP_PARTY, sandboxParty(running.value)]);

// EVERY AREA AT ONCE IS NOT A LIST, IT IS A WALL. Past the wholesale threshold the drift reaches all forty-odd
// areas of the product, and drawing a row each indicts the whole app for one cause while burying the missing
// routes — the part a reader can still act on — forty rows down. So the drifted rows stand down to one sentence
// there, and the other two kinds keep their rows.
const listed = computed(() => (driftScope.value === `wholesale` ? [] : driftedRoutes.value));
const areas = computed(() =>
    driftAreas({ missing: missingRoutes.value, drifted: listed.value, extra: unknownDaemonRoutes.value }),
);
// Counted over everything that disagrees, not over what is listed: the caption is the size of the problem.
const affected = computed(() => missingRoutes.value.length + driftedRoutes.value.length + unknownDaemonRoutes.value.length);
const caption = computed(() => `${plural(affected.value, `call`, `calls`)} · ${plural(driftedAreas.value.length, `area`, `areas`)}`);
const wholesaleNote = computed(() =>
    driftScope.value === `wholesale`
        ? `${driftedRoutes.value.length} of ${comparedRouteCount.value} shared calls carry different fields — every area of the app, so they aren't listed one by one.`
        : undefined,
);

// Closed on arrival: the card's job is to name what is affected, and the dotted route names behind a row are for
// whoever is about to go and fix it.
const opened = ref<Record<string, boolean>>({});
const toggle = (key: string, open: boolean): void => {
    opened.value = { ...opened.value, [key]: open };
};

// Every route this area contributes, in the order the kinds are explained below it.
const evidence = (area: (typeof areas.value)[number]): readonly string[] => [...area.missing, ...area.drifted, ...area.extra];
// Only the kinds this area actually holds, so a drifted-only row doesn't explain what "missing" would have meant.
const kindsOf = (area: (typeof areas.value)[number]) =>
    ([`missing`, `drifted`, `extra`] as const).filter((kind) => area[kind].length > 0);
</script>

<template>
    <RowGroup v-if="daemonBehind || daemonDrifted" :label="heading" :caption="caption">
        <!-- The cause, before any list: a reader who misreads why is going to misread every row under it. -->
        <RowNote icon="exclamation-triangle" tone="warning">{{ cause }}</RowNote>

        <!-- WHICH TWO PROGRAMS THESE ARE. The pair is the whole point of the block: one runs in the tab being read,
             the other in the container answering it, and each states the size of its own call surface so the count
             in the caption has a scale to be read against. -->
        <Row v-for="party in parties" :key="party.label" :icon="party.icon" :title="party.label" :description="party.what">
            <template #meta>
                <span v-if="party.calls !== undefined" class="font-mono text-2xs tabular-nums text-subtle">{{
                    t(`sandbox.sandboxBehindCard.nCalls`, { count: party.calls })
                }}</span>
            </template>
        </Row>
        <!-- The one reassuring line here, and only where something drifted: on a card about calls the sandbox simply
             lacks, "all of them match" is a sentence about the wrong set and reads as a contradiction of the heading. -->
        <RowNote v-if="daemonDrifted && !wholesaleNote && agreementLine" icon="check" tone="success">{{ agreementLine }}</RowNote>
        <RowNote v-if="wholesaleNote" icon="arrows-h" tone="warning">{{ wholesaleNote }}</RowNote>

        <!-- One row per area of the product, not per route: a single shared schema reaches dozens of routes across
             areas that have nothing to do with each other, and the flat name list read as that many separate faults. -->
        <DisclosureRow
            v-for="area in areas"
            :key="area.key"
            :icon="KIND_ICON[area.kind]"
            :tone="KIND_TONE[area.kind]"
            :title="area.label"
            :description="area.where"
            :open="opened[area.key] === true"
            @update:open="toggle(area.key, $event)"
        >
            <template #meta>
                <StatusBadge :variant="KIND_BADGE[area.kind]" size="xs" :label="`${area.count} ${KIND_TAG[area.kind]}`" />
            </template>
            <template #below>
                <div class="flex flex-col gap-2 pb-1">
                    <p v-for="kind in kindsOf(area)" :key="kind" class="text-2xs text-muted">{{ KIND_IMPACT[kind] }}</p>
                    <!-- The dotted names, last: they are what a fix is written against, and what nobody else needs. -->
                    <ul class="flex flex-wrap gap-x-3 gap-y-1">
                        <li v-for="route in evidence(area)" :key="route" class="font-mono text-2xs text-subtle">{{ route }}</li>
                    </ul>
                </div>
            </template>
        </DisclosureRow>

        <RowNote variant="block">
            <div class="flex flex-col gap-3">
                <div v-if="isDev" class="flex flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                        <!-- Compiles and restarts the daemon out there; this page's own connection dies with it. -->
                        <Button
                            v-if="hostId"
                            :label="reloading ? t(`sandbox.sandboxBehindCard.reloading`) : t(`sandbox.sandboxBehindCard.reloadSandbox`)"
                            size="small"
                            :loading="reloading"
                            @click="void reloadOnDevice()"
                        >
                            <template #icon><Icon name="bolt" /></template>
                        </Button>
                        <!-- Withheld while the cause is an uncompiled contract: this page is the fresher of the two, so reloading it changes nothing. -->
                        <Button
                            v-if="(daemonDrifted && !contractUncompiled) || reloaded"
                            :label="t(`sandbox.sandboxBehindCard.reloadPage`)"
                            size="small"
                            severity="secondary"
                            @click="reloadPage"
                        />
                        <span v-if="hostId" class="text-2xs text-subtle">
                            <template v-if="reloaded">{{ t(`sandbox.sandboxBehindCard.rebuiltOnReloadPage`, { hostId }) }}</template>
                            <template v-else-if="reloading">{{ t(`sandbox.sandboxBehindCard.compilingOnRestartingContainer`, { hostId }) }}</template>
                            <template v-else>{{ t(`sandbox.sandboxBehindCard.compilesWorkingTreeOn`, { hostId }) }}</template>
                        </span>
                    </div>
                    <!-- THE OTHER BUTTON, NAMED BEFORE IT IS FOUND. Environment carries "Rebuild from checkout", which
                         builds a whole image and takes minutes; this reload recompiles the daemon in the container that
                         is already running. Two near-identical offers on two tabs read as one action duplicated until
                         something says which is which, and the cheaper one is the right answer to a contract gap. -->
                    <p v-if="!reloaded" class="text-2xs text-subtle">
                        {{ t(`sandbox.sandboxBehindCard.reloadRecompilesDaemon`) }}
                        <RouterLink to="/sandbox/environment" class="text-link hover:underline">{{
                            t(`sandbox.sandboxBehindCard.environmentTab`)
                        }}</RouterLink>
                    </p>
                    <Notice v-if="failed" tone="warning" class="text-2xs">{{ failed }}</Notice>
                    <div v-if="showCommand" class="flex flex-wrap items-center gap-2">
                        <span class="text-2xs text-subtle">{{
                            daemonDrifted && !failed ? t(`sandbox.sandboxBehindCard.stillHereRun`) : t(`sandbox.sandboxBehindCard.run`)
                        }}</span>
                        <div class="sandbox-reload-command flex min-w-0 flex-1 items-center rounded-md border border-line bg-canvas">
                            <Code class="min-w-0 flex-1" :code="reloadCommand" lang="bash" :copyable="false" />
                            <CopyButton
                                :text="reloadCommand"
                                :label="t(`ui.action.copy`)"
                                :aria-label="t(`sandbox.sandboxBehindCard.copyReloadCommand`)"
                                class="mr-1"
                            />
                        </div>
                    </div>
                    <!-- Only where the button never had a chance: a refusal means the door is open and something else went wrong, which connecting a second time would not fix. -->
                    <ConnectDeviceHint v-if="!hostId" :slug="slug" gains="this becomes a button." />
                </div>
                <div v-else-if="daemonDrifted" class="flex flex-wrap items-center gap-2">
                    <Button :label="t(`sandbox.sandboxBehindCard.reloadPage`)" size="small" @click="reloadPage" />
                    <span class="text-2xs text-subtle">{{ t(`sandbox.sandboxBehindCard.staysUpdateSandboxImage`) }}</span>
                </div>
                <p v-else class="text-2xs text-subtle">{{ t(`sandbox.sandboxBehindCard.updateSandboxImage`) }}</p>
            </div>
        </RowNote>
    </RowGroup>
</template>

<style scoped>
/* Keep Code's syntax highlighting and theme; let the row itself own the border and copy button styling. */
.sandbox-reload-command :deep(.shiki),
.sandbox-reload-command :deep(pre) {
    border: 0;
    background-color: transparent !important;
}
</style>
