/* The thrown thing's message, for the places that need a STRING rather than something to show a person: a log line, an IPC reply's `error` field. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The errno a Node system call failed with (`ENOENT`, `EACCES`), or undefined for anything that is not one.
export const errnoCode = (error: unknown): string | undefined => {
    const code = typeof error === `object` && error !== null ? (error as { code?: unknown }).code : undefined;
    return typeof code === `string` ? code : undefined;
};

// The path, or a directory on the way to it, is not there. EACCES, EISDIR, EIO and a bug's TypeError are not "missing".
export const isMissing = (error: unknown): boolean => {
    const code = errnoCode(error);
    return code === `ENOENT` || code === `ENOTDIR`;
};

// A `.catch` handler for a filesystem call whose target may legitimately be absent: undefined then, rethrown otherwise.
export const undefinedIfMissing = (error: unknown): undefined => {
    if (isMissing(error)) {
        return undefined;
    }
    throw error;
};
