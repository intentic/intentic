// How a daemon refusal reads, for both clients (typed and raw). Import-free, so a suite that fakes a client can still
// throw the real class and code under test can still recognize it.

// What a refusal's body said, field by field: an oRPC handler's `message`, a hand-written route's `error`.
export interface RefusalWords {
    readonly message?: string;
    readonly error?: string;
}

// A non-2xx daemon answer, carrying the HTTP status so callers can branch on it without matching message text, and the
// body's own words for the few that phrase a refusal themselves.
export class SandboxHttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly said: RefusalWords = {},
    ) {
        super(message);
    }
}

// A call's answer, or the daemon's refusal as a value to branch on; a call that got no answer at all still throws.
export const orRefusal = <T>(call: Promise<T>): Promise<T | SandboxHttpError> =>
    call.catch((error: unknown) => {
        if (error instanceof SandboxHttpError) {
            return error;
        }
        throw error;
    });

// The words a refusal's body carries, whatever else it holds.
export const wordsOf = (body: unknown): RefusalWords => {
    if (typeof body !== `object` || body === null) {
        return {};
    }
    const { message, error } = body as { readonly message?: unknown; readonly error?: unknown };
    return { ...(typeof message === `string` ? { message } : {}), ...(typeof error === `string` ? { error } : {}) };
};

// The daemon's own words for a refusal: its `message`, else a hand-written route's `error`, else the bare status.
export const refusalText = (status: number, said: RefusalWords): string => said.message ?? said.error ?? `Request failed (${status}).`;
