import { PROCESS_ROLES, type SandboxMetrics } from "@intentic/sandbox-contract";
import type { Tip } from "@intentic/ui";
import { formatBinaryBytes, formatFixed, formatPercent } from "@intentic/ui/format";
import { type TypedT, useT } from "@intentic/ui/i18n";
import { computed, type ComputedRef } from "vue";
import { heaviestRoles, heaviestSessions, NEAR_LIMIT, PRESSURE_STALLING, PRESSURE_WORTH_SHOWING, sessionHeavy } from "./liveMetrics";

// The board's geek metrics as the places that draw them read them: three gauges (CPU, memory, disk: the figures that run
// out) for the quiet bar at the foot of the board, every other figure for the panel it opens, and one conversation's
// share for its card and the panel's list of them. A figure near its limit is flagged, so the bar can raise it without
// the reader opening anything.

export interface Gauge {
    readonly key: `cpu` | `memory` | `disk`;
    readonly label: string;
    // Short enough for the bar: "43%", "9.3 / 16 GiB".
    readonly value: string;
    // The full reading, for the panel and for a screen reader: "43% of 16 cores", "9.3 GiB / 16 GiB".
    readonly detail: string;
    // How full, 0 to 1; undefined on a first reading, which has no CPU yet.
    readonly fraction: number | undefined;
    // What the figure measures, on hover: its name and the one caveat that changes how it reads.
    readonly hint: Tip;
    readonly warn: boolean;
}

export interface Figure {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly hint: Tip;
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

export interface SessionRow {
    // The conversation's id, which its title is looked up by where the row is drawn.
    readonly key: string;
    // Its memory, "1.3 GiB", and its CPU, "179%", undefined on a first reading.
    readonly value: string;
    readonly cpu: string | undefined;
    readonly bytes: number;
    // Share of the heaviest conversation, so the longest bar is always full and the rest read against it.
    readonly share: number;
    readonly heavy: boolean;
    // The whole reading, for a hover: CPU, memory and how many processes, one row each.
    readonly tip: Tip;
}

export interface MemoryRow {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    readonly excluded: boolean;
}

export interface SandboxReadout {
    readonly gauges: readonly Gauge[];
    // Measured cgroup accounting, not a residual inferred from the process RSS lists below.
    readonly memoryRows: readonly MemoryRow[];
    readonly figures: readonly Figure[];
    // The kinds worth a glance, heaviest first; the small ones fold away (smallRoles) behind one line that sums them.
    readonly roles: readonly RoleRow[];
    readonly smallRoles: readonly RoleRow[];
    readonly smallRolesBytes: number;
    // The conversations holding the most memory, heaviest first; past the first few they fold away (smallSessions).
    readonly sessions: readonly SessionRow[];
    readonly smallSessions: readonly SessionRow[];
    readonly smallSessionsBytes: number;
    // Figures past a limit, besides the gauges: what the bar names on its own so nobody has to open the panel to see it.
    readonly alerts: readonly Figure[];
}

// "9.3 / 16 GiB" when both halves share a unit, which is the common case; both units kept when they differ.
export const usedOf = (used: number, total: number): string => {
    const [usedText, totalText] = [formatBinaryBytes(used), formatBinaryBytes(total)];
    const unit = totalText.slice(totalText.lastIndexOf(` `));
    return usedText.endsWith(unit) ? `${usedText.slice(0, -unit.length)} / ${totalText}` : `${usedText} / ${totalText}`;
};

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

// A kind under this much memory folds away: a long list of 40 MiB kinds buries the two that matter.
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

// The conversations always shown; the rest fold behind one line, since the list answers where the memory went and its
// tail answers least. Folded only when that hides more than one, as with the kinds.
const SESSIONS_SHOWN = 5;

export const splitSessions = <Row>(rows: readonly Row[]): [Row[], Row[]] =>
    rows.length - SESSIONS_SHOWN < 2 ? [[...rows], []] : [rows.slice(0, SESSIONS_SHOWN), rows.slice(SESSIONS_SHOWN)];

// One conversation's reading as a card, as its card's hover and the panel's row show it: CPU where there is a reading of
// it (a first reading has none, and its row is dropped), then memory, then how many processes. In the words of the
// caller's own `t`.
export const sessionTip = (
    t: TypedT,
    session: { readonly cpuPercent?: number | undefined; readonly rssBytes: number; readonly processes: number },
): Tip => ({
    title: t(`agents.liveMetrics.sessionUsage`),
    rows: [
        { label: t(`agents.liveMetrics.cpuLabel`), value: session.cpuPercent === undefined ? `` : formatPercent(session.cpuPercent) },
        { label: t(`agents.liveMetrics.rssLabel`), value: formatBinaryBytes(session.rssBytes) },
        { label: t(`agents.liveMetrics.processesLabel`), value: session.processes },
    ],
    note: t(`agents.liveMetrics.cpuPerCore`),
});

// Warned exactly when the daemon would hold a person's turn: the same figures and the same thresholds, read off one
// reading. A reading without `memoryRoom` (a daemon older than it) warns of nothing: no threshold is guessed here.
export const memoryShort = (sandbox: SandboxMetrics[`sandbox`]): boolean => {
    const room = sandbox.memoryRoom;
    return (
        room !== undefined &&
        ((room.freeBytes !== undefined && room.freeBytes < room.personNeedBytes) ||
            room.stallPercent >= room.stallLimitPercent ||
            (room.stallSustainedPercent !== undefined &&
                room.stallSustainedLimitPercent !== undefined &&
                room.stallSustainedPercent >= room.stallSustainedLimitPercent))
    );
};

// Optional measured categories keep unknown distinct from zero. Neither RSS nor the headline is used to guess a row.
export const memoryRowsOf = (t: TypedT, sandbox: SandboxMetrics[`sandbox`]): MemoryRow[] => {
    const breakdown = sandbox.memoryBreakdown;
    const fields = [
        { key: `anonymousBytes`, label: t(`agents.liveMetrics.anonymousLabel`), excluded: false },
        { key: `countedFileCacheBytes`, label: t(`agents.liveMetrics.fileCacheLabel`), excluded: false },
        { key: `kernelBytes`, label: t(`agents.liveMetrics.kernelLabel`), excluded: false },
        { key: `inactiveFileCacheBytes`, label: t(`agents.liveMetrics.inactiveCacheLabel`), excluded: true },
    ] as const;
    return fields.flatMap(({ key, label, excluded }) => {
        const bytes = breakdown?.[key];
        return bytes === undefined ? [] : [{ key, label, excluded, value: formatBinaryBytes(bytes) }];
    });
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
            hint: { title: t(`agents.liveMetrics.cpuLabel`), note: t(`agents.liveMetrics.cpuNote`) },
            warn: (sandbox.cpuPercent ?? 0) >= NEAR_LIMIT * 100,
        };
        const memory: Gauge = {
            key: `memory`,
            label: t(`agents.liveMetrics.memoryLabel`),
            value: usedOf(sandbox.memoryBytes, sandbox.memoryLimitBytes),
            detail: `${formatBinaryBytes(sandbox.memoryBytes)} / ${formatBinaryBytes(sandbox.memoryLimitBytes)}`,
            fraction: sandbox.memoryLimitBytes > 0 ? clamp(sandbox.memoryBytes / sandbox.memoryLimitBytes) : undefined,
            hint: { title: t(`agents.liveMetrics.memoryLabel`), note: t(`agents.liveMetrics.memoryNote`) },
            warn: memoryShort(sandbox),
        };
        if (sandbox.diskBytes === undefined || sandbox.diskTotalBytes === undefined) {
            return [cpu, memory];
        }
        const disk: Gauge = {
            key: `disk`,
            label: t(`agents.liveMetrics.diskLabel`),
            value: usedOf(sandbox.diskBytes, sandbox.diskTotalBytes),
            detail: `${formatBinaryBytes(sandbox.diskBytes)} / ${formatBinaryBytes(sandbox.diskTotalBytes)}`,
            fraction: sandbox.diskTotalBytes > 0 ? clamp(sandbox.diskBytes / sandbox.diskTotalBytes) : undefined,
            hint: { title: t(`agents.liveMetrics.diskLabel`), note: t(`agents.liveMetrics.diskNote`) },
            warn: sandbox.diskBytes >= NEAR_LIMIT * sandbox.diskTotalBytes,
        };
        return [cpu, memory, disk];
    };

    // Load as cores' worth of work against the cores there are, and which way it is heading: three bare averages mean
    // nothing to a reader who does not already know how many cores stand behind them. The averages are the hint's rows.
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
            hint: {
                title: t(`agents.liveMetrics.loadLabel`),
                rows: [
                    { label: t(`agents.liveMetrics.minutes`, { count: 1 }), value: formatFixed(one, 2) },
                    { label: t(`agents.liveMetrics.minutes`, { count: 5 }), value: formatFixed(five, 2) },
                    { label: t(`agents.liveMetrics.minutes`, { count: 15 }), value: formatFixed(fifteen, 2) },
                ],
                note: t(`agents.liveMetrics.loadNote`),
            },
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
                          // Against what swap can hold where the daemon says, since a full swap is what makes it count.
                          value:
                              sandbox.swapLimitBytes === undefined
                                  ? formatBinaryBytes(sandbox.swapBytes)
                                  : usedOf(sandbox.swapBytes, sandbox.swapLimitBytes),
                          hint: {
                              title: t(`agents.liveMetrics.swapLabel`),
                              note: sandbox.swapFull === true ? t(`agents.liveMetrics.swapFullNote`) : t(`agents.liveMetrics.swapNote`),
                          },
                          warn: sandbox.swapFull === true,
                      },
                  ]),
            loadOf(sandbox),
            {
                key: `processes`,
                label: t(`agents.liveMetrics.processesLabel`),
                value: formatFixed(sandbox.processes, 0),
                hint: { title: t(`agents.liveMetrics.processesLabel`), note: t(`agents.liveMetrics.processesNote`) },
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
                          hint: { title: t(`agents.liveMetrics.pressureLabel`), note: t(`agents.liveMetrics.pressureNote`) },
                          warn: worst >= PRESSURE_STALLING,
                      },
                  ]),
            {
                key: `daemon`,
                label: t(`agents.liveMetrics.daemonLabel`),
                value: [
                    formatBinaryBytes(daemon.rssBytes),
                    ...(daemon.cpuPercent === undefined ? [] : [t(`agents.liveMetrics.cpu`, { percent: formatPercent(daemon.cpuPercent) })]),
                    ...(daemon.eventLoopPercent === undefined
                        ? []
                        : [t(`agents.liveMetrics.loop`, { percent: formatPercent(daemon.eventLoopPercent) })]),
                ].join(` · `),
                hint: {
                    title: t(`agents.liveMetrics.daemonLabel`),
                    rows: [
                        { label: t(`agents.liveMetrics.rssLabel`), value: formatBinaryBytes(daemon.rssBytes) },
                        { label: t(`agents.liveMetrics.cpuLabel`), value: daemon.cpuPercent === undefined ? `` : formatPercent(daemon.cpuPercent) },
                        {
                            label: t(`agents.liveMetrics.eventLoop`),
                            value: daemon.eventLoopPercent === undefined ? `` : formatPercent(daemon.eventLoopPercent),
                        },
                    ],
                    note: t(`agents.liveMetrics.daemonNote`),
                },
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
            value: formatBinaryBytes(rssBytes),
            bytes: rssBytes,
            share: heaviest === 0 ? 0 : rssBytes / heaviest,
        }));
    };

    const sessionsOf = ({ sessions, sandbox }: SandboxMetrics): SessionRow[] => {
        const held = heaviestSessions(sessions);
        const heaviest = held[0]?.rssBytes ?? 0;
        return held.map((session) => ({
            key: session.id,
            value: formatBinaryBytes(session.rssBytes),
            cpu: session.cpuPercent === undefined ? undefined : formatPercent(session.cpuPercent),
            bytes: session.rssBytes,
            share: heaviest === 0 ? 0 : session.rssBytes / heaviest,
            heavy: sessionHeavy(session.rssBytes, sandbox),
            tip: sessionTip(t, session),
        }));
    };

    return computed(() => {
        const reading = metrics();
        const figures = figuresOf(reading);
        const [roles, smallRoles] = splitRoles(rolesOf(reading));
        const [sessions, smallSessions] = splitSessions(sessionsOf(reading));
        return {
            gauges: gaugesOf(reading),
            memoryRows: memoryRowsOf(t, reading.sandbox),
            figures,
            roles,
            smallRoles,
            smallRolesBytes: smallRoles.reduce((sum, role) => sum + role.bytes, 0),
            sessions,
            smallSessions,
            smallSessionsBytes: smallSessions.reduce((sum, session) => sum + session.bytes, 0),
            alerts: figures.filter((figure) => figure.warn),
        };
    });
}
