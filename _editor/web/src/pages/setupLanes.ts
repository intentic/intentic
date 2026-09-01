/* WHAT THE PROVISION SPINE CAN ACTUALLY OFFER, decided in one pure place beside the page (the setupArrival.ts
 * and hostedWait.ts pattern), because getting it wrong is what put a brand-new account in front of a form
 * asking for a domain it does not have.
 *
 * THE OLD SHAPE AND WHY IT WAS WRONG. The page asked the platform two questions on arrival — do you mint
 * addresses, do you host machines — and answered BOTH with `false` when the call failed. A read that never
 * landed and a platform that genuinely provisions nothing were then indistinguishable, so both fell through to
 * the same place: `lane = "attach"`, which is the one-step lane for somebody already running a sandbox behind a
 * domain of their own. For that reader it is the right screen. For everyone else it is the product asking a
 * stranger, thirty seconds after sign-up, to supply the infrastructure it was supposed to supply — and a
 * single failed request was enough to cause it.
 *
 * So the reads are three-valued here, and the difference between "no" and "we could not ask" is the whole
 * point of the module: one is a fact to state, the other is a retry.
 *
 * NOTHING HERE SWITCHES LANES. The page no longer moves the reader onto the attach lane on its behalf; it says
 * what is true and leaves the link. A lane the reader did not choose, arriving with no explanation, is how the
 * whole confusion started. */

// An offer read: what the platform said, or the fact that it never answered.
export type OfferRead<T> = { readonly kind: "answered"; readonly value: T } | { readonly kind: "unreachable" };

export interface LaneInput {
    // sandbox.addressOffer: whether this platform mints addresses, so a pasted command or an app handoff has
    // something to redeem.
    readonly address: OfferRead<boolean>;
    // sandbox.hostedOffer: whether it runs machines, and how many more this account may create.
    readonly hosted: OfferRead<{ readonly enabled: boolean; readonly remaining: number }>;
    /* This sandbox already HAS a machine of ours. A lane all by itself, and it outranks every offer: the
     * hardware exists, so whatever the platform says about NEW ones is beside the point. A resumed hosted
     * sandbox that reads the offers alone would otherwise be told there is nothing to take, about a box that
     * is already booting for it. */
    readonly hasMachine: boolean;
}

export type Lanes =
    // There is something on the provision spine to take. The ordinary answer, and the only one that draws the
    // ladder and the run step.
    | { readonly kind: "takeable" }
    /* We could not ask. Says so and offers the retry — never "this platform provisions nothing", which is a
     * claim about the platform made on the strength of a request that failed. */
    | { readonly kind: "unreachable" }
    /* The platform hosts, and this account's one machine is somewhere else. The distinction earns its own case
     * because the remedy is specific and cheerful: open the sandbox you already have. */
    | { readonly kind: "spent" }
    // This platform genuinely provisions nothing: no fabric, no hosting. Attach is not a fallback here, it is
    // the product, and saying so plainly is the honest screen.
    | { readonly kind: "none" };

const answered = <T,>(read: OfferRead<T>): T | undefined => (read.kind === `answered` ? read.value : undefined);

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
    /* A READ THAT FAILED OUTRANKS A "NO" FROM THE OTHER ONE, and this ordering is the fix. With the address
     * offer answering false and the hosted read lost to a blip, the facts in hand do not add up to "this
     * platform provisions nothing" — they add up to not knowing, and the honest screen for not knowing is a
     * retry. Reversed, one dropped request permanently reframes the product. */
    if (input.address.kind === `unreachable` || input.hosted.kind === `unreachable`) {
        return { kind: `unreachable` };
    }
    if (hosted?.enabled === true) {
        return { kind: `spent` };
    }
    return { kind: `none` };
};
