<script setup lang="ts">
import type { SandboxMetrics } from "@intentic/sandbox-contract";
import { formatBytes, formatFixed, formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { heaviestRoles, NEAR_LIMIT, PRESSURE_STALLING, PRESSURE_WORTH_SHOWING } from "./liveMetrics";

// The sandbox line of the board's geek metrics: CPU, memory, swap, disk and load, the daemon that runs it all, and
// which kinds of process hold the memory. Every figure explains itself on hover, since "load" or "pressure" is a
// number only a reader who already knows it can read bare.

const t = useT();

const props = defineProps<{
    metrics: SandboxMetrics;
}>();

// How many kinds "memory by kind" names; past four the line wraps on a laptop-width board.
const ROLES_SHOWN = 4;

interface Figure {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly hint: string;
    // Near a limit: tinted so the one number worth acting on stands out of a line of them.
    readonly warn: boolean;
}

const cpuFigure = (sandbox: SandboxMetrics[`sandbox`]): Figure => {
    const cores = formatFixed(sandbox.cores, Number.isInteger(sandbox.cores) ? 0 : 1);
    return {
        key: `cpu`,
        label: t(`agents.liveMetrics.cpuLabel`),
        // The first reading after a quiet spell has no CPU yet; the capacity is still worth saying.
        value:
            sandbox.cpuPercent === undefined
                ? t(`agents.liveMetrics.coresValue`, { cores }, sandbox.cores)
                : t(`agents.liveMetrics.cpuValue`, { percent: formatPercent(sandbox.cpuPercent), cores }, sandbox.cores),
        hint: t(`agents.liveMetrics.cpuHint`),
        warn: (sandbox.cpuPercent ?? 0) >= NEAR_LIMIT * 100,
    };
};

const pressureFigure = (pressure: SandboxMetrics[`sandbox`][`pressure`]): Figure[] => {
    const worst = pressure === undefined ? 0 : Math.max(pressure.cpu, pressure.memory, pressure.io);
    if (pressure === undefined || worst < PRESSURE_WORTH_SHOWING) {
        return [];
    }
    return [
        {
            key: `pressure`,
            label: t(`agents.liveMetrics.pressureLabel`),
            value: t(`agents.liveMetrics.pressureValue`, {
                cpu: formatPercent(pressure.cpu),
                memory: formatPercent(pressure.memory),
                io: formatPercent(pressure.io),
            }),
            hint: t(`agents.liveMetrics.pressureHint`),
            warn: worst >= PRESSURE_STALLING,
        },
    ];
};

const daemonFigure = (daemon: SandboxMetrics[`daemon`]): Figure => ({
    key: `daemon`,
    label: t(`agents.liveMetrics.daemonLabel`),
    value: [
        formatBytes(daemon.rssBytes),
        ...(daemon.cpuPercent === undefined ? [] : [t(`agents.liveMetrics.cpu`, { percent: formatPercent(daemon.cpuPercent) })]),
        ...(daemon.eventLoopPercent === undefined ? [] : [t(`agents.liveMetrics.loop`, { percent: formatPercent(daemon.eventLoopPercent) })]),
    ].join(` · `),
    hint: t(`agents.liveMetrics.daemonHint`),
    warn: (daemon.eventLoopPercent ?? 0) >= NEAR_LIMIT * 100,
});

const figures = computed<Figure[]>(() => {
    const { sandbox, daemon, roles } = props.metrics;
    const heaviest = heaviestRoles(roles, ROLES_SHOWN);
    return [
        cpuFigure(sandbox),
        {
            key: `memory`,
            label: t(`agents.liveMetrics.memoryLabel`),
            value: `${formatBytes(sandbox.memoryBytes)} / ${formatBytes(sandbox.memoryLimitBytes)}`,
            hint: t(`agents.liveMetrics.memoryHint`),
            warn: sandbox.memoryBytes >= NEAR_LIMIT * sandbox.memoryLimitBytes,
        },
        ...(sandbox.swapBytes === undefined || sandbox.swapBytes === 0
            ? []
            : [{ key: `swap`, label: t(`agents.liveMetrics.swapLabel`), value: formatBytes(sandbox.swapBytes), hint: t(`agents.liveMetrics.swapHint`), warn: false }]),
        ...(sandbox.diskBytes === undefined || sandbox.diskTotalBytes === undefined
            ? []
            : [
                  {
                      key: `disk`,
                      label: t(`agents.liveMetrics.diskLabel`),
                      value: `${formatBytes(sandbox.diskBytes)} / ${formatBytes(sandbox.diskTotalBytes)}`,
                      hint: t(`agents.liveMetrics.diskHint`),
                      warn: sandbox.diskBytes >= NEAR_LIMIT * sandbox.diskTotalBytes,
                  },
              ]),
        {
            key: `load`,
            label: t(`agents.liveMetrics.loadLabel`),
            value: sandbox.loadAverage.map((load) => formatFixed(load, 2)).join(` `),
            hint: t(`agents.liveMetrics.loadHint`),
            warn: false,
        },
        {
            key: `processes`,
            label: t(`agents.liveMetrics.processesLabel`),
            value: formatFixed(sandbox.processes, 0),
            hint: t(`agents.liveMetrics.processesHint`),
            warn: false,
        },
        ...pressureFigure(sandbox.pressure),
        daemonFigure(daemon),
        ...(heaviest.length === 0
            ? []
            : [
                  {
                      key: `roles`,
                      label: t(`agents.liveMetrics.rolesLabel`),
                      value: heaviest.map((share) => `${t(`agents.liveMetrics.role.${share.role}`)} ${formatBytes(share.rssBytes)}`).join(` · `),
                      hint: t(`agents.liveMetrics.rolesHint`),
                      warn: false,
                  },
              ]),
    ];
});
</script>

<template>
    <div
        role="group"
        :aria-label="t(`agents.liveMetrics.sandboxLabel`)"
        class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3 py-1.5 text-2xs"
    >
        <Icon name="server" class="shrink-0 text-2xs text-subtle" />
        <span v-for="figure in figures" :key="figure.key" v-tooltip.bottom="figure.hint" class="inline-flex min-w-0 items-baseline gap-1.5">
            <span class="shrink-0 text-subtle">{{ figure.label }}</span>
            <span class="truncate font-mono tabular-nums" :class="figure.warn ? `text-warning` : `text-muted`">{{ figure.value }}</span>
        </span>
    </div>
</template>
