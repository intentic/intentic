// The platform's offers as a new sandbox reads them: mint an address, host a machine. Reads are three-valued so a
// failed request (`unreachable`) is never confused with a real `false`.

// An offer read: what the platform said, or the fact that it never answered.
export type OfferRead<T> = { readonly kind: "answered"; readonly value: T } | { readonly kind: "unreachable" };

// oRPC surfaces a disabled endpoint as NOT_FOUND (404): the platform's own answer that a feature is off.
const isNotFound = (err: unknown): boolean => {
    if (!err || typeof err !== `object`) {
        return false;
    }
    const { code, status } = err as { code?: unknown; status?: unknown };
    return code === `NOT_FOUND` || status === 404;
};

// One offer read: a 404 is a real answer (the feature is genuinely off), a timeout, drop or 500 says nothing and is not
// recorded as one. Resolve-then-call, so a missing client method lands in the catch rather than throwing at the call.
export const readOffer = <T>(call: () => Promise<T>, absent: T): Promise<OfferRead<T>> =>
    Promise.resolve()
        .then(async (): Promise<OfferRead<T>> => ({ kind: `answered`, value: await call() }))
        .catch((err: unknown): OfferRead<T> => (isNotFound(err) ? { kind: `answered`, value: absent } : { kind: `unreachable` }));
