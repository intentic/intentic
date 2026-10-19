import type { StartWindow } from "./start-window.js";

// The start window held in memory, for a suite that is not about what a restart keeps: the same ceiling, no file.
export const memoryStartWindow = (windowMs = 3_600_000): StartWindow => {
    const starts = new Map<string, number[]>();
    return {
        spend: async (key, max, now) => {
            const recent = (starts.get(key) ?? []).filter((at) => now - at < windowMs);
            const spent = recent.length < max;
            starts.set(key, spent ? [...recent, now] : recent);
            return spent;
        },
    };
};
