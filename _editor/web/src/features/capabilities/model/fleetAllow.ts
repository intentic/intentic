import type { AddCapabilityInput } from "@intentic/capability-catalog";
import { t } from "@intentic/ui/i18n";

// THE SANDBOX FLEET CARD'S ALLOW. The editor is signed in to the owner's account, so it mints the `provision` token the
// card needs itself, through the same platform call Settings ▸ Tokens makes, and saves it to the card: nobody copies a
// token from one page of this app into another. The token is listed on Settings ▸ Tokens under this sandbox's name, and
// carries its platform id (`tokenId`) onto the card, so the daemon revokes it when the card goes (fleet.handler.ts).

// The platform's ceiling on a token's label (api-contract tokenContract.create).
const LABEL_MAX = 80;

/** What the token is listed as on Settings ▸ Tokens: the card's name and this sandbox's, so the owner knows it there. */
export const fleetTokenLabel = (sandboxName: string | undefined): string => {
    const name = sandboxName?.trim() ?? ``;
    return (name === `` ? t(`capabilities.fleetAllow.tokenLabelUnnamed`) : t(`capabilities.fleetAllow.tokenLabel`, { name })).slice(0, LABEL_MAX);
};

export interface FleetAllowSeams {
    // The platform's mint, under the reader's session: Settings ▸ Tokens' own call.
    readonly mint: (label: string) => Promise<{ readonly id: string; readonly token: string }>;
    readonly revoke: (tokenId: string) => Promise<void>;
    // The card's save: the daemon's streamed add, which throws on a refused one.
    readonly save: (input: AddCapabilityInput) => Promise<void>;
}

/**
 * Mints the token and saves it to the card `id`. A save that fails takes the token back, so no live token is left on the
 * account that no card holds; the save's own refusal is what is thrown.
 */
export const allowFleet = async (seams: FleetAllowSeams, id: string, label: string): Promise<void> => {
    const minted = await seams.mint(label);
    try {
        await seams.save({ id, kind: `fleet`, config: { token: minted.token, tokenId: minted.id } });
    } catch (refused) {
        // allow(silent-catch): the save's refusal is the one the reader needs; a revoke that also fails leaves the token
        // listed on Settings ▸ Tokens, under this sandbox's name.
        await seams.revoke(minted.id).catch(() => undefined);
        throw refused;
    }
};
