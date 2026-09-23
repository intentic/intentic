// Decides, in one pure place, what the provision spine can offer: mint an address, host a machine, or neither.
// Reads are three-valued so a failed request (`unreachable`) is never confused with a real `false`; the module
// never switches lanes itself, only states what is true.

// An offer read: what the platform said, or the fact that it never answered.
export type OfferRead<T> = { readonly kind: "answered"; readonly value: T } | { readonly kind: "unreachable" };

export interface LaneInput {
    // Maps to `sandbox.addressOffer`: whether this platform mints addresses.
    readonly address: OfferRead<boolean>;
    // Maps to `sandbox.hostedOffer`: whether it runs machines, and how many more this account may create.
    readonly hosted: OfferRead<{ readonly enabled: boolean; readonly remaining: number }>;
    // Already has a machine; outranks every offer regardless of what the platform reports.
    readonly hasMachine: boolean;
}

export type Lanes =
    // Something on the provision spine to take; draws the ladder and the run step.
    | { readonly kind: "takeable" }
    // Could not ask; offers a retry rather than claiming the platform provisions nothing.
    | { readonly kind: "unreachable" }
    // Platform hosts, but this account's machine already exists elsewhere; the remedy is to open it.
    | { readonly kind: "spent" }
    // Platform provisions nothing: no fabric, no hosting. Attach is the product here, not a fallback.
    | { readonly kind: "none" };

const answered = <T>(read: OfferRead<T>): T | undefined => (read.kind === `answered` ? read.value : undefined);

// oRPC surfaces a disabled endpoint as NOT_FOUND (404): the platform's own answer that a feature is off.
export const isNotFound = (err: unknown): boolean => {
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

export const lanesFor = (input: LaneInput): Lanes => {
    // Hardware already attached to this row beats every question about new hardware.
    if (input.hasMachine) {
        return { kind: `takeable` };
    }
    const address = answered(input.address);
    const hosted = answered(input.hosted);
    if (address === true || (hosted?.enabled === true && hosted.remaining > 0)) {
        return { kind: `takeable` };
    }
    // A failed read outranks a `false` from the other offer: unknown reads as retry, not as "provisions nothing".
    if (input.address.kind === `unreachable` || input.hosted.kind === `unreachable`) {
        return { kind: `unreachable` };
    }
    if (hosted?.enabled === true) {
        return { kind: `spent` };
    }
    return { kind: `none` };
};
