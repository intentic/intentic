// HOW THIS SANDBOX GETS REBUILT, from where the reader sits, decided in one place so the Environment card always says
// something about it: the control, or one sentence saying why there is none here and what to do instead. A reader once
// sat under "Rebuild needed" for an hour, clicking the card's tabs and its refresh, on a card that drew neither.
//
// The lanes are the card's, in its order: the platform's build for a hosted sandbox (its owner's alone), the deploy
// command for a server-managed one, the checkout rebuild on the Sandbox tab, the device swap for a sandbox the
// installer started (`intentic-sandbox-<slug>`). A container nobody here started has no lane at all, which is said.

export type RebuildRoute =
    | `hosted`
    | `owner-only`
    | `server`
    | `checkout`
    | `device`
    // Waiting to be built, with no way to build it from here.
    | `elsewhere`;

export interface RebuildFacts {
    // An approved recipe the running container was not built from. Contents marks a block as arriving after a rebuild only
    // then (the daemon's contents.ts), so nothing waits on a rebuild while none is pending.
    readonly pending: boolean;
    readonly hosted: boolean;
    readonly owner: boolean;
    readonly serverManaged: boolean;
    // Built from a checkout, and the reader may operate it (EnvironmentCard `fromCheckout`).
    readonly fromCheckout: boolean;
    readonly slug: string | undefined;
}

// Undefined when there is nothing to rebuild.
export const rebuildRouteOf = (facts: RebuildFacts): RebuildRoute | undefined => {
    if (!facts.pending) {
        return undefined;
    }
    if (facts.hosted) {
        return facts.owner ? `hosted` : `owner-only`;
    }
    if (facts.serverManaged) {
        return `server`;
    }
    if (facts.fromCheckout) {
        return `checkout`;
    }
    return facts.slug === undefined ? `elsewhere` : `device`;
};
