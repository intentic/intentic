import { readFile } from "node:fs/promises";

export interface WorkerIdleOptions {
    readonly idleMs?: number;
    readonly pressureIdleMs?: number;
    readonly underPressure?: () => Promise<boolean>;
    readonly onError?: (error: Error) => void;
}

// A host without cgroup PSI keeps the normal idle window.
const underPressure = async (): Promise<boolean> => {
    // allow(silent-catch): cgroup PSI is optional on development hosts; no reading means no pressure override.
    const text = await readFile("/sys/fs/cgroup/memory.pressure", "utf8").catch(() => "");
    return Number(/^full avg10=([\d.]+)/mu.exec(text)?.[1] ?? 0) >= 5;
};

// Only armed once the LAST request finishes. A new request cancels even a pressure read already in flight.
export const workerIdle = (options: WorkerIdleOptions, release: () => Promise<void>) => {
    const idleMs = options.idleMs ?? 15 * 60_000;
    const pressureIdleMs = Math.min(idleMs, options.pressureIdleMs ?? 2 * 60_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let quietSince = 0;
    const busy = (): void => {
        generation += 1;
        clearTimeout(timer);
    };
    const arm = (): void => {
        const own = generation;
        timer = setTimeout(() => {
            void (async () => {
                const pressured = await (options.underPressure ?? underPressure)();
                if (own !== generation) {return;}
                if (Date.now() - quietSince >= (pressured ? pressureIdleMs : idleMs)) {
                    await release();
                } else {
                    arm();
                }
            })().catch((error: Error) => {
                options.onError?.(error);
                if (own === generation) {arm();}
            });
        }, Math.max(1, Math.min(30_000, pressureIdleMs)));
        timer.unref();
    };
    return {
        busy,
        quiet: (): void => {
            busy();
            quietSince = Date.now();
            arm();
        },
    };
};
