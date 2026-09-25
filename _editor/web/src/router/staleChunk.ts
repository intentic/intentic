import { loadChunk } from "@intentic/ui/chunk";

/**
 * A dynamic import nobody awaits: a terminal panel an agent surfaces mid-run, a model catalog reloaded after a turn
 * failed. `loadChunk` answers a redeploy with one reload onto the page the reader is on; this only adds the report a
 * fire-and-forget import would otherwise reject into nothing.
 */
export const importOrReload = <T>(load: () => Promise<T>, use: (module: T) => unknown): void => {
    void loadChunk(load).then(
        (module) => {
            // The module's own failure is a bug, not a redeploy, and must not be read as one.
            void Promise.resolve(use(module)).catch((error: unknown) => {
                console.error(`late import failed after loading`, error);
            });
        },
        (error: unknown) => {
            console.error(`late import failed`, error);
        },
    );
};
