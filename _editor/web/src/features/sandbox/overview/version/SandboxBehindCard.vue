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
    appParty,
    driftAreas,
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
// WHAT IT DRAWS IS THE TWO SIDES AND THEN THE EVIDENCE, because "7 routes disagree" named the mechanism and nothing
// a reader could act on: not which two things are failing to meet, not what goes wrong, not where they would see it.
// The sides are two rows, the fallout is one row per part of the app (driftReport.ts), and the dotted route names —
// the only part that was ever on screen — are now what a chevron opens.
//
// EVERY SENTENCE HERE IS WRITTEN FOR SOMEONE WHO DID NOT BUILD THIS. No "contract", "route", "call", "daemon",
// "compiled" or "working tree" reaches the screen; those words made the first two versions of this card unreadable.
// And nothing here says RELOAD for what restarts the sandbox: to anyone with a browser open, reload is F5. The
// sandbox restarts, the page reloads, and the card must never blur the two.

const t = useT();

// Dev gets the restart button; a non-dev user is pointed at the update card instead.
const isDev = import.meta.env.DEV;
const { slug, localImage } = useEnvironment();
// A dev sandbox runs the code straight off the checkout, not out of the image: a restart picks a change up, a
// full image rebuild is not needed for one.
const restartCommand = computed(() => `sh _sandbox/sandbox/scripts/dev-restart.sh${slug.value === undefined ? `` : ` ${slug.value}`}`);
// The one thing on this card that IS an F5, and the only thing allowed to be called a reload.
const reloadPage = (): void => location.reload();

// The environment holding this sandbox's checkout, when it is a connected device: then the restart is a button here
// and the command below is only for a checkout nothing can reach. The checkout, not merely the machine — a PC reports
// this container through its Windows side too, and the restart is a `sh` line in a folder only one side has.
const running = useHostHolding(
    () => slug.value,
    () => localImage.value?.root,
);
const { devices } = useDevices({ poll: false });
const onlineDevices = computed(() => devices.value.filter((device) => device.hostId !== undefined && device.online === true));
// dev-restart.sh is a unix line whatever else is true, so a door that runs one itself is the first choice; a Windows
// door is still offered when it is the only one, since the daemon crosses into that PC's distro from there.
const unixDoors = computed(() => onlineDevices.value.filter((device) => device.platform !== `windows`));
// Which machine runs this sandbox is itself read off the daemon's fleet payload, so a daemon far enough behind to
// disagree about that payload answers "none" — and the one button that fixes it would vanish with the field it was
// gated on, exactly when this card is on screen. A single online machine is not a guess, so it is offered: the restart's
// argv names this sandbox's own slug on the far side, so a machine that doesn't hold it refuses rather than restarting
// something else. Two of them is a guess, and stays the printed command; two doors onto one PC (Windows and a distro
// on it) are one machine, and the distro's door is the one that can run the script.
const hostId = computed(
    () => running.value ?? (machinesOf(onlineDevices.value).length === 1 ? (unixDoors.value[0] ?? onlineDevices.value[0])?.hostId : undefined),
);
const hubWork = useHubWork();
const restarting = ref(false);
const restarted = ref(false);
const failed = ref<string | undefined>(undefined);
// A refusal (an older container with no checkout recorded, a device with commands switched off) hands the command
// back, since the button has just proved it cannot do this here.
const showCommand = computed(() => hostId.value === undefined || failed.value !== undefined);

const restartOnDevice = async (): Promise<void> => {
    const id = hostId.value;
    if (id === undefined || restarting.value) {
        return;
    }
    restarting.value = true;
    failed.value = undefined;
    restarted.value = false;
    const endMark = hubWork.begin(`Restarting the sandbox`);
    try {
        // Undefined is the expected ending: the container being restarted is the one answering this request.
        await runSeveringDeviceCommand(id, `dev-restart`);
        restarted.value = true;
    } catch (error) {
        failed.value = error instanceof Error ? error.message : String(error);
    } finally {
        restarting.value = false;
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

// Each side lacking routes the other has: the two builds forked rather than one trailing the other, so neither "behind"
// nor "out of sync" is true and no single restart is the answer.
const forked = computed(() => daemonBehind.value && appBehind.value);

// Five diagnoses, most specific first. An uncompiled contract explains missing routes and drifted ones alike — the
// compiled copy the sandbox runs simply predates the edit — so it outranks the rest rather than being one more guess
// about which side is older.
const heading = computed(() => {
    if (contractUncompiled.value) {
        return `Your sandbox hasn't picked up your latest changes`;
    }
    if (forked.value) {
        return `This page and your sandbox are from different versions`;
    }
    if (daemonBehind.value) {
        return `Your sandbox is older than this page`;
    }
    return driftScope.value === `wholesale` ? `This page and your sandbox are far apart` : `Some parts of this page may not work`;
});

// Named as its own clause rather than folded into the heading: a newer sandbox than tab is ordinary, and only worth
// saying once something else has proved the two disagree. Never on a fork, which says it better already.
const leaning = computed(() => (appBehind.value && !forked.value && !contractUncompiled.value ? ` This page is the older of the two.` : ``));

// WHY, in one sentence and no numbers. Partial drift has no cause row: the heading and per-feature rows carry it.
const cause = computed((): string | undefined => {
    if (contractUncompiled.value) {
        return `You've changed code your sandbox hasn't rebuilt yet, so it's still running the old version. Refreshing this page won't help — the sandbox is the side that needs to catch up.`;
    }
    if (forked.value) {
        return `Each side has parts the other has never heard of, so neither one is simply newer. Restarting won't settle it on its own.`;
    }
    if (daemonBehind.value) {
        return `Your sandbox was built before these parts existed, so it doesn't know about them.`;
    }
    if (driftScope.value === `wholesale`) {
        return `Almost nothing lines up — these are two quite different versions, not one small change.${leaning.value}`;
    }
    const extra = leaning.value.trim();
    return extra === `` ? undefined : extra;
});

// Which machine the sandbox is actually on, said only when this app is sure of it: the fallback `hostId` above is a
// one-device guess, good enough to aim a restart at and not good enough to state as a fact.
const parties = computed(() => [appParty(), sandboxParty(running.value)]);

// EVERY AREA AT ONCE IS NOT A LIST, IT IS A WALL. Past the wholesale threshold the drift reaches all forty-odd
// areas of the product, and drawing a row each indicts the whole app for one cause while burying the missing
// routes — the part a reader can still act on — forty rows down. So the drifted rows stand down to one sentence
// there, and the other two kinds keep their rows.
const listed = computed(() => (driftScope.value === `wholesale` ? [] : driftedRoutes.value));
const areas = computed(() =>
    driftAreas({ missing: missingRoutes.value, drifted: listed.value, extra: unknownDaemonRoutes.value }),
);
const wholesaleNote = computed(() =>
    driftScope.value === `wholesale` ? `Nearly every part of the app is affected, so they aren't listed one by one.` : undefined,
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
    <RowGroup v-if="daemonBehind || daemonDrifted" :label="heading">
        <!-- The cause, before any list: a reader who misreads why is going to misread every row under it. -->
        <RowNote v-if="cause !== undefined" icon="exclamation-triangle" tone="warning">{{ cause }}</RowNote>

        <!-- WHICH TWO THINGS THESE ARE: the one being looked at, and the one behind it. The tag marks only the side
             something PROVES is behind — a guess here sends somebody to restart the wrong one. -->
        <Row v-for="party in parties" :key="party.label" :icon="party.icon" :title="party.label" :description="party.what">
            <template #meta>
                <StatusBadge
                    v-if="party.age"
                    :variant="party.age === `older` ? `warning` : `neutral`"
                    size="xs"
                    :label="party.age === `older` ? t(`sandbox.sandboxBehindCard.olderSide`) : t(`sandbox.sandboxBehindCard.newerSide`)"
                />
            </template>
        </Row>
        <!-- The one reassuring line here, and only where something drifted: on a card about features the sandbox
             simply lacks, "everything else lines up" is about the wrong set and contradicts the heading above it. -->
        <RowNote v-if="daemonDrifted && !wholesaleNote && agreementLine" icon="check" tone="success">{{ agreementLine }}</RowNote>
        <RowNote v-if="wholesaleNote" icon="arrows-h" tone="warning">{{ wholesaleNote }}</RowNote>

        <!-- One row per part of the app, not per route: one shared piece of code reaches dozens of routes across
             parts that have nothing to do with each other, and the flat name list read as that many separate faults. -->
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
                <StatusBadge :variant="KIND_BADGE[area.kind]" size="xs" :label="KIND_TAG[area.kind]" />
            </template>
            <template #below>
                <div class="flex flex-col gap-2 pb-1">
                    <p v-for="kind in kindsOf(area)" :key="kind" class="text-2xs text-muted">{{ KIND_IMPACT[kind] }}</p>
                    <!-- The internal names, last and quietest: what a fix is written against, and what nobody else needs. -->
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
                        <!-- RESTART, NEVER "RELOAD": this rebuilds and restarts the whole sandbox out there, and the
                             button beside it is the one that means F5. One word for each, so nobody presses the wrong. -->
                        <Button
                            v-if="hostId"
                            :label="restarting ? t(`sandbox.sandboxBehindCard.restarting`) : t(`sandbox.sandboxBehindCard.restartSandbox`)"
                            size="small"
                            :loading="restarting"
                            @click="void restartOnDevice()"
                        >
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <!-- Withheld while the sandbox is the stale side: this page is the fresher of the two, so refreshing it changes nothing. -->
                        <Button
                            v-if="(daemonDrifted && !contractUncompiled) || restarted"
                            :label="t(`sandbox.sandboxBehindCard.reloadPage`)"
                            size="small"
                            severity="secondary"
                            @click="reloadPage"
                        />
                        <span v-if="hostId" class="text-2xs text-subtle">
                            <template v-if="restarted">{{ t(`sandbox.sandboxBehindCard.rebuiltOnReloadPage`, { hostId }) }}</template>
                            <template v-else-if="restarting">{{ t(`sandbox.sandboxBehindCard.restartingOn`, { hostId }) }}</template>
                            <template v-else>{{ t(`sandbox.sandboxBehindCard.rebuildsYourCodeOn`, { hostId }) }}</template>
                        </span>
                    </div>
                    <!-- THE OTHER BUTTON, NAMED BEFORE IT IS FOUND. Environment carries "Rebuild from checkout", which
                         builds a whole new image and takes minutes; this one restarts the sandbox that is already
                         running. Two near-identical offers on two tabs read as one action duplicated until something
                         says which is which, and the quick one is the right answer to a version gap. -->
                    <p v-if="!restarted" class="text-2xs text-subtle">
                        {{ t(`sandbox.sandboxBehindCard.restartIsQuicker`) }}
                        <RouterLink to="/sandbox/environment" class="text-link hover:underline">{{
                            t(`sandbox.sandboxBehindCard.environmentTab`)
                        }}</RouterLink>
                    </p>
                    <Notice v-if="failed" tone="warning" class="text-2xs">{{ failed }}</Notice>
                    <div v-if="showCommand" class="flex flex-wrap items-center gap-2">
                        <span class="text-2xs text-subtle">{{
                            daemonDrifted && !failed ? t(`sandbox.sandboxBehindCard.stillHereRun`) : t(`sandbox.sandboxBehindCard.run`)
                        }}</span>
                        <div class="sandbox-restart-command flex min-w-0 flex-1 items-center rounded-md border border-line bg-canvas">
                            <Code class="min-w-0 flex-1" :code="restartCommand" lang="bash" :copyable="false" />
                            <CopyButton
                                :text="restartCommand"
                                :label="t(`ui.action.copy`)"
                                :aria-label="t(`sandbox.sandboxBehindCard.copyRestartCommand`)"
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
.sandbox-restart-command :deep(.shiki),
.sandbox-restart-command :deep(pre) {
    border: 0;
    background-color: transparent !important;
}
</style>
