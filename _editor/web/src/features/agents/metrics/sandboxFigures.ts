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
    readonly bytes: number;
    // Share of the heaviest kind, so the longest bar is always full and the rest read against it.
    readonly share: number;
}

export interface SandboxReadout {
    readonly gauges: readonly Gauge[];
    readonly figures: readonly Figure[];
    // The kinds worth a glance, heaviest first; the small ones fold away (smallRoles) behind one line that sums them.
    readonly roles: readonly RoleRow[];
    readonly smallRoles: readonly RoleRow[];
    readonly smallRolesBytes: number;
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

// A kind under this much memory folds away: a long list of 40 MB kinds buries the two that matter.
export const SMALL_ROLE_BYTES = 100 * 2 ** 20;
// The heaviest few always show, whatever they hold, so the list never folds down to nothing.
const ROLES_ALWAYS_SHOWN = 3;

export type LoadTrend = `rising` | `falling` | `steady`;

// Which way the machine's load is heading: the last minute against the last quarter hour, past a margin a single build
// starting or ending would not cross.
export const loadTrend = ([one, , fifteen]: readonly [number, number, number]): LoadTrend => {
    const margin = Math.max(0.5, 0.2 * fifteen);
    return one - fifteen > margin ? `rising` : fifteen - one > margin ? `falling` : `steady`;
};

// Where the kinds split into shown and folded: under SMALL_ROLE_BYTES past the first few, and only when that folds
// more than one, since a fold that hides a single row saves nothing.
export const splitRoles = <Row extends { readonly bytes: number }>(rows: readonly Row[]): [Row[], Row[]] => {
    const firstSmall = rows.findIndex((row) => row.bytes < SMALL_ROLE_BYTES);
    const at = firstSmall === -1 ? rows.length : Math.max(ROLES_ALWAYS_SHOWN, firstSmall);
    return rows.length - at < 2 ? [[...rows], []] : [rows.slice(0, at), rows.slice(at)];
};

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

    // Load as cores' worth of work against the cores there are, and which way it is heading: three bare averages mean
    // nothing to a reader who does not already know how many cores stand behind them. The averages stay in the hint.
    const loadOf = ({ loadAverage, machineCores }: SandboxMetrics[`sandbox`]): Figure => {
        const [one, five, fifteen] = loadAverage;
        const load = formatFixed(one, 1);
        const busy =
            machineCores === undefined
                ? t(`agents.liveMetrics.loadBusy`, { load })
                : t(`agents.liveMetrics.loadOf`, { load, cores: formatFixed(machineCores, 0) }, machineCores);
        return {
            key: `load`,
            label: t(`agents.liveMetrics.loadLabel`),
            value: `${busy} · ${t(`agents.liveMetrics.loadTrend.${loadTrend(loadAverage)}`)}`,
            hint: `${t(`agents.liveMetrics.loadHint`)} ${t(`agents.liveMetrics.loadAverages`, {
                one: formatFixed(one, 2),
                five: formatFixed(five, 2),
                fifteen: formatFixed(fifteen, 2),
            })}`,
            warn: false,
        };
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
            loadOf(sandbox),
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
            bytes: rssBytes,
            share: heaviest === 0 ? 0 : rssBytes / heaviest,
        }));
    };

    return computed(() => {
        const reading = metrics();
        const figures = figuresOf(reading);
        const [roles, smallRoles] = splitRoles(rolesOf(reading));
        return {
            gauges: gaugesOf(reading),
            figures,
            roles,
            smallRoles,
            smallRolesBytes: smallRoles.reduce((sum, role) => sum + role.bytes, 0),
            alerts: figures.filter((figure) => figure.warn),
        };
    });
}
