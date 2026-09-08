// An already-aborted signal never fires `addEventListener('abort', …)` (events aren't replayed); this runs the handler
// synchronously instead and returns an always-safe unregister function.
export const whenAborted = (signal: AbortSignal | undefined, handler: () => void): (() => void) => {
    if (signal === undefined) {
        return (): void => {};
    }
    if (signal.aborted) {
        handler();
        return (): void => {};
    }
    signal.addEventListener("abort", handler, { once: true });
    return (): void => signal.removeEventListener("abort", handler);
};
