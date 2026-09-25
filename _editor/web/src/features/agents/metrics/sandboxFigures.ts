import { PROCESS_ROLES, type SandboxMetrics } from "@intentic/sandbox-contract";
import { formatBytes, formatFixed, formatPercent } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, type ComputedRef } from "vue";
import { heaviestRoles, NEAR_LIMIT, PRESSURE_STALLING, PRESSURE_WORTH_SHOWING } from "./liveMetrics";

// The board's geek metrics as the two places that draw them read them: three gauges (CPU, memory, disk: the figures
// that run out) for the quiet bar at the foot of the board, and every other figure for the panel it opens. A figure
// near its limit is flagged, so the bar can raise it without the reader opening anything.

export interface Gauge {
    readonly key: `cpu` | `memory` | `disk`;
    readonly label: string;
    // Short enough for the bar: "43%", "9.3 / 16 GB".
    readonly value: string;
    // The full reading, for the panel and for a screen reader: "43% of 16 cores", "9.3 GB / 16 GB".
    readonly detail: string;
    // How full, 0 to 1; undefined on a first reading, which has no CPU yet.
    readonly fraction: number | undefined;
    readonly hint: string;
    readonly warn: boolean;
}

export interface Figure {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly hint: string;
    readonly warn: boolean;
}

export interface RoleRow {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    // Share of the heaviest kind, so the longest bar is always full and the rest read against it.
    readonly share: number;
}

export interface SandboxReadout {
    readonly gauges: readonly Gauge[];
    readonly figures: readonly Figure[];
    readonly roles: readonly RoleRow[];
    // Figures past a limit, besides the gauges: what the bar names on its own so nobody has to open the panel to see it.
    readonly alerts: readonly Figure[];
}

// "9.3 / 16 GB" when both halves share a unit, which is the common case; both units kept when they differ.
export const usedOf = (used: number, total: number): string => {
    const [usedText, totalText] = [formatBytes(used), formatBytes(total)];
    const unit = totalText.slice(totalText.lastIndexOf(` `));
    return usedText.endsWith(unit) ? `${usedText.slice(0, -unit.length)} / ${totalText}` : `${usedText} / ${totalText}`;
};

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

// Warned exactly when the daemon would hold a person's turn: the same figures and the same thresholds, read off one
// reading. A daemon that predates `memoryRoom` sends neither, and its gauge falls back to how full it is.
export const memoryShort = (sandbox: SandboxMetrics[`sandbox`]): boolean => {
    const room = sandbox.memoryRoom;
    if (room === undefined) {
        return sandbox.memoryBytes >= NEAR_LIMIT * sandbox.memoryLimitBytes;
    }
    return (room.freeBytes !== undefined && room.freeBytes < room.personNeedBytes) || room.stallPercent >= room.stallLimitPercent;
};

export function useSandboxReadout(metrics: () => SandboxMetrics): ComputedRef<SandboxReadout> {
    const t = useT();

    const gaugesOf = ({ sandbox }: SandboxMetrics): Gauge[] => {
        const cores = formatFixed(sandbox.cores, Number.isInteger(sandbox.cores) ? 0 : 1);
        const cpu: Gauge = {
            key: `cpu`,
            label: t(`agents.liveMetrics.cpuLabel`),
            // The first reading after a quiet spell has no CPU yet; the capacity is still worth saying.
            value: sandbox.cpuPercent === undefined ? `–` : formatPercent(sandbox.cpuPercent),
            detail:
                sandbox.cpuPercent === undefined
                    ? t(`agents.liveMetrics.coresValue`, { cores }, sandbox.cores)
                    : t(`agents.liveMetrics.cpuValue`, { percent: formatPercent(sandbox.cpuPercent), cores }, sandbox.cores),
            fraction: sandbox.cpuPercent === undefined ? undefined : clamp(sandbox.cpuPercent / 100),
            hint: t(`agents.liveMetrics.cpuHint`),
            warn: (sandbox.cpuPercent ?? 0) >= NEAR_LIMIT * 100,
        };
        const memory: Gauge = {
            key: `memory`,
            label: t(`agents.liveMetrics.memoryLabel`),
            value: usedOf(sandbox.memoryBytes, sandbox.memoryLimitBytes),
            detail: `${formatBytes(sandbox.memoryBytes)} / ${formatBytes(sandbox.memoryLimitBytes)}`,
            fraction: sandbox.memoryLimitBytes > 0 ? clamp(sandbox.memoryBytes / sandbox.memoryLimitBytes) : undefined,
            hint: t(`agents.liveMetrics.memoryHint`),
            warn: memoryShort(sandbox),
        };
        if (sandbox.diskBytes === undefined || sandbox.diskTotalBytes === undefined) {
            return [cpu, memory];
        }
        const disk: Gauge = {
            key: `disk`,
            label: t(`agents.liveMetrics.diskLabel`),
            value: usedOf(sandbox.diskBytes, sandbox.diskTotalBytes),
            detail: `${formatBytes(sandbox.diskBytes)} / ${formatBytes(sandbox.diskTotalBytes)}`,
            fraction: sandbox.diskTotalBytes > 0 ? clamp(sandbox.diskBytes / sandbox.diskTotalBytes) : undefined,
            hint: t(`agents.liveMetrics.diskHint`),
            warn: sandbox.diskBytes >= NEAR_LIMIT * sandbox.diskTotalBytes,
        };
        return [cpu, memory, disk];
    };

    const figuresOf = ({ sandbox, daemon }: SandboxMetrics): Figure[] => {
        const { pressure } = sandbox;
        const worst = pressure === undefined ? 0 : Math.max(pressure.cpu, pressure.memory, pressure.io);
        return [
            ...(sandbox.swapBytes === undefined || sandbox.swapBytes === 0
                ? []
                : [
                      {
                          key: `swap`,
                          label: t(`agents.liveMetrics.swapLabel`),
                          value: formatBytes(sandbox.swapBytes),
                          hint: t(`agents.liveMetrics.swapHint`),
                          warn: false,
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
            // Below the threshold nothing is waiting, and three zeros are noise even in the panel.
            ...(pressure === undefined || worst < PRESSURE_WORTH_SHOWING
                ? []
                : [
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
                  ]),
            {
                key: `daemon`,
                label: t(`agents.liveMetrics.daemonLabel`),
                value: [
                    formatBytes(daemon.rssBytes),
                    ...(daemon.cpuPercent === undefined ? [] : [t(`agents.liveMetrics.cpu`, { percent: formatPercent(daemon.cpuPercent) })]),
                    ...(daemon.eventLoopPercent === undefined
                        ? []
                        : [t(`agents.liveMetrics.loop`, { percent: formatPercent(daemon.eventLoopPercent) })]),
                ].join(` · `),
                hint: t(`agents.liveMetrics.daemonHint`),
                warn: (daemon.eventLoopPercent ?? 0) >= NEAR_LIMIT * 100,
            },
        ];
    };

    const rolesOf = ({ roles }: SandboxMetrics): RoleRow[] => {
        const held = heaviestRoles(roles, PROCESS_ROLES.length);
        const heaviest = held[0]?.rssBytes ?? 0;
        return held.map(({ role, rssBytes }) => ({
            key: role,
            label: t(`agents.liveMetrics.role.${role}`),
            value: formatBytes(rssBytes),
            share: heaviest === 0 ? 0 : rssBytes / heaviest,
        }));
    };

    return computed(() => {
        const reading = metrics();
        const figures = figuresOf(reading);
        return { gauges: gaugesOf(reading), figures, roles: rolesOf(reading), alerts: figures.filter((figure) => figure.warn) };
    });
}
