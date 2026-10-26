import type { Logger } from "pino";

export interface ReaperBrowsers {
    readonly runningOwners: () => readonly string[];
    readonly idleNames: (now: number, idleMs: number) => readonly string[];
    readonly close: (name: string) => Promise<void>;
    readonly closeFor: (owner: string, idleOnly?: boolean) => Promise<void>;
}

export const closeIdleBrowsers = async (
    browsers: ReaperBrowsers,
    now: number,
    idleMs: number,
    underPressure: (() => Promise<boolean>) | undefined,
    logger: Pick<Logger, "info">,
): Promise<void> => {
    const pressured = await underPressure?.() ?? false;
    const idle = browsers.idleNames(now, pressured ? Math.min(idleMs, 2 * 60_000) : idleMs);
    if (idle.length > 0) {
        await Promise.all(idle.map((name) => browsers.close(name)));
        logger.info({ count: idle.length, sessions: idle.slice(0, 10), pressured }, "reaper: closed idle browsers");
    }
};
