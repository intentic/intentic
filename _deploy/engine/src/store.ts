// Marks an output that does not yet exist during plan mode (its producer is a pending create).
export const PENDING = Symbol("pending-output");

// The in-run output store. Keyed by the VERBATIM refKey string so dotted ids ("my-app.staging") and
// bare-vs-output refs all resolve through one lookup with no string splitting. Each reconciled resource
// seeds its own bare key: set(id, id), plus set(refKey(id, name), value) for every produced output.
export interface OutputStore {
    readonly set: (key: string, value: unknown) => void;
    readonly has: (key: string) => boolean;
    readonly get: (key: string, options: { readonly lenient: boolean }) => unknown;
}

export const createStore = (): OutputStore => {
    const values = new Map<string, unknown>();
    return {
        set: (key, value) => {
            values.set(key, value);
        },
        has: (key) => values.has(key),
        get: (key, options) => {
            if (!values.has(key)) {
                if (options.lenient) {
                    return PENDING;
                }
                throw new Error(`cannot resolve {$ref:"${key}"}: not produced this run`);
            }
            return values.get(key);
        },
    };
};
