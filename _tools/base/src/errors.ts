/* The thrown thing's message, for the places that need a STRING rather than something to show a person: a log line, an IPC reply's `error` field. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The errno a Node system call failed with (`ENOENT`, `EACCES`), or undefined for anything that is not one.
export const errnoCode = (error: unknown): string | undefined => {
    const code = typeof error === `object` && error !== null ? (error as { code?: unknown }).code : undefined;
    return typeof code === `string` ? code : undefined;
};

// READING ANOTHER PROGRAM'S FAILURE BY ITS STRUCTURE, NOT ITS SENTENCE. A message is worded by whoever threw it, and that
// wording moves: Node's fetch says `fetch failed` where Bun says `ECONNREFUSED: Unable to connect…`, Node's spawn says
// `spawn git ENOENT` where Bun says `Executable not found in $PATH`, and a translated git says neither. The code, the
// exit status and the class are what each runtime agrees on, so a caller branches on those and keeps the sentence for
// a person to read.

// One field of a thrown value, which is `unknown` by the language's own contract (a catch binding); the callers below
// each narrow what comes back.
const fieldOf = (value: unknown, key: string): unknown =>
    // SAFETY: a non-null object is indexable by string; a missing key reads undefined, which every caller handles.
    typeof value === `object` && value !== null ? (value as Record<string, unknown>)[key] : undefined;

// What a failed child process wrote to stderr, as execFile, `ProcessError` (@intentic/base/process) and the git runner
// hang it on what they throw; undefined for anything that is not a process's failure.
export const stderrOf = (error: unknown): string | undefined => {
    const stderr = fieldOf(error, `stderr`);
    return typeof stderr === `string` ? stderr : undefined;
};

// The status a failed child process exited with: execFile and ProcessError carry it as a numeric `code`, where a
// string `code` is the errno its spawn failed with. Undefined for a signal, a spawn failure and anything else; a
// DOMException's numeric `code` is its legacy error number, not an exit.
export const exitCodeOf = (error: unknown): number | undefined => {
    if (typeof DOMException !== `undefined` && error instanceof DOMException) {
        return undefined;
    }
    const code = fieldOf(error, `code`);
    return typeof code === `number` && Number.isInteger(code) ? code : undefined;
};

// How far down a cause chain a code is looked for: undici nests at most two levels (the TypeError, its cause, and an
// AggregateError's attempts), so four is generous and still bounds a cycle.
const CAUSE_DEPTH = 4;

// The errno or runtime code a failed network call carries, wherever the runtime hangs it: Bun puts it on the error
// itself, Node's fetch (undici) on the error's `cause`, an AggregateError there when several addresses were tried
// (`localhost` is ::1 and 127.0.0.1). `ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_SOCKET`.
export const networkCodeOf = (error: unknown): string | undefined => {
    let at: unknown = error;
    for (let depth = 0; depth < CAUSE_DEPTH && at !== undefined && at !== null; depth += 1) {
        const code = errnoCode(at);
        if (code !== undefined) {
            return code;
        }
        const attempts = fieldOf(at, `errors`);
        const attempted = Array.isArray(attempts) ? errnoCode(attempts[0]) : undefined;
        if (attempted !== undefined) {
            return attempted;
        }
        at = fieldOf(at, `cause`);
    }
    return undefined;
};

// A request fetch refused to send at all (`fetch("not a url")`): the caller's bug, not the network's.
const MALFORMED_REQUEST = /^ERR_INVALID_/;

/**
 * Whether a fetch failed before any response arrived: refused, unresolved, reset, unreachable. The Fetch standard
 * rejects a network error with a TypeError and leaves its message to the runtime, so this reads the class and the code
 * under it. A TypeError with neither a code nor a cause is a bug in the code around the fetch, not the network. An
 * abort or a deadline is a DOMException and reads false; tell those apart by its `name`.
 */
export const isFetchNetworkFailure = (error: unknown): boolean => {
    // By name rather than instanceof, so an error from another realm (a worker, a vm context) reads the same.
    if (!(error instanceof Error) || error.name !== `TypeError`) {
        return false;
    }
    const code = networkCodeOf(error);
    return code === undefined ? fieldOf(error, `cause`) !== undefined : !MALFORMED_REQUEST.test(code);
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
