// HOW A SANDBOX THE UPDATE CARD CANNOT SWAP UPDATES. Compose owns the container when the sandbox says so
// (SANDBOX_MANAGER), and the card hands over Compose's own update, since an `ic` swap would recreate the container behind
// Compose's back. A sandbox on its owner's own machine with no container name was started by neither the setup command
// nor the desktop app (both name it), which leaves Compose from a file written before it said so, or a hand-run
// `docker run`: the same command, offered as the likely way rather than the known one. Either way there is no button to
// press, since nothing on the page reaches that machine. Hosted and deploy-managed sandboxes update their own way.

import { computed, type ComputedRef } from "vue";
import { useSandboxVersion } from "../../../../models/sandbox/useSandboxVersion";

export type ComposeOffer = `known` | `likely`;

export interface ComposeFacts {
    readonly hosted: boolean;
    readonly serverManaged: boolean;
    readonly composeManaged: boolean;
    readonly slug: string | undefined;
}

export const composeOfferOf = ({ hosted, serverManaged, composeManaged, slug }: ComposeFacts): ComposeOffer | undefined => {
    if (hosted || serverManaged) {
        return undefined;
    }
    if (composeManaged) {
        return `known`;
    }
    return slug === undefined ? `likely` : undefined;
};

export function useComposeOffer(hosted: () => boolean): ComputedRef<ComposeOffer | undefined> {
    const { serverManaged, composeManaged, slug } = useSandboxVersion();
    return computed(() => composeOfferOf({ hosted: hosted(), serverManaged: serverManaged.value, composeManaged: composeManaged.value, slug: slug.value }));
}
