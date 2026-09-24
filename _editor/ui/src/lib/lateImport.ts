// The kit loads heavy libraries lazily, but only the app knows whether a failed chunk means "reload onto a fresh build".
let onFailure: ((error: unknown) => void) | undefined;

/** Called once at app start with the handler every failed kit import reports to. */
export const setLateImportFailure = (handler: (error: unknown) => void): void => {
    onFailure = handler;
};

// Still rejects after reporting, so the caller's own fallback (source in place of a diagram) shows if no reload comes.
export const lateImport = async <T>(load: () => Promise<T>): Promise<T> => {
    try {
        return await load();
    } catch (error) {
        onFailure?.(error);
        throw error;
    }
};
