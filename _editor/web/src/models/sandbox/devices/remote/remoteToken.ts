import type { RemoteToken } from "./remoteApi";

// A REMOTE SOCKET'S TOKEN, KEPT FRESH. The sandbox hands each device socket a short-lived token; the one held is renewed
// (`refresh`) well before it lapses and handed to the open socket (`{type: "token"}`), so a socket outlives every token
// it was opened with, and the next dial always has a live one. When to renew is read off the token's lifetime as this
// computer saw it arrive, not off its `expiresAt` against this computer's clock, which may be minutes off the sandbox's:
// halfway through, never sooner than MIN_RENEW_MS nor later than MAX_RENEW_MS. A renewal that fails is tried again
// after RETRY_MS; the socket keeps the token it has meanwhile, and a socket the far end closes for its token (4001,
// 4002) dials again with a fresh one asked for then (`fresh`).

export const MIN_RENEW_MS = 5_000;
export const MAX_RENEW_MS = 10 * 60_000;
export const RETRY_MS = 15_000;
// A lifetime that reads as nothing (a clock far ahead of the sandbox's): renewed as if it had a minute.
const UNREADABLE_LIFETIME_MS = 60_000;

export interface TokenKeeperOptions {
    readonly refresh: () => Promise<RemoteToken>;
    // A renewed token, for the open socket.
    readonly renewed: (token: RemoteToken) => void;
    readonly now?: (() => number) | undefined;
    readonly later?: ((run: () => void, ms: number) => () => void) | undefined;
}

export interface TokenKeeper {
    // The token to dial with now.
    readonly current: () => string | undefined;
    // A token that arrived with the grant (open, attach) or from a renewal: held, and its renewal planned.
    readonly take: (token: RemoteToken) => void;
    // Asks for a fresh token now (a dial after a refusal), and holds it.
    readonly fresh: () => Promise<string>;
    readonly dispose: () => void;
}

const timeout = (run: () => void, ms: number): (() => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
};

/** When to renew a token that lives `lifetime` ms from now. */
export const renewAfter = (lifetime: number): number => {
    const half = (lifetime > 0 ? lifetime : UNREADABLE_LIFETIME_MS) / 2;
    return Math.min(MAX_RENEW_MS, Math.max(MIN_RENEW_MS, half));
};

export const tokenKeeper = (options: TokenKeeperOptions): TokenKeeper => {
    const now = options.now ?? Date.now;
    const later = options.later ?? timeout;
    let held: string | undefined;
    let cancel: (() => void) | undefined;
    let disposed = false;

    const plan = (ms: number): void => {
        cancel?.();
        cancel = later(() => void renew(), ms);
    };
    const hold = (token: RemoteToken): void => {
        held = token.token;
        plan(renewAfter(token.expiresAt - now()));
    };
    const renew = async (): Promise<void> => {
        if (disposed) {
            return;
        }
        try {
            const token = await options.refresh();
            if (!disposed) {
                hold(token);
                options.renewed(token);
            }
        } catch {
            // allow(silent-catch): the socket keeps the token it has, and the next try is planned; a socket closed for its
            // token asks for a fresh one when it dials.
            if (!disposed) {
                plan(RETRY_MS);
            }
        }
    };

    return {
        current: () => held,
        take: hold,
        fresh: async () => {
            const token = await options.refresh();
            hold(token);
            return token.token;
        },
        dispose: () => {
            disposed = true;
            cancel?.();
            cancel = undefined;
        },
    };
};
