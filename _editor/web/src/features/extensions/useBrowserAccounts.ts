import { computed } from "vue";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { useExtensions } from "./useExtensions";

// Logged-in browser accounts dressed for display: a capability's id is the account (`reddit-work`), its `platform` is
// the site (`reddit`), and only the site has a logo. Brand comes from the same contributed cards /capabilities uses, so
// an account wears one mark everywhere; everything falls back safely to a glyph or initials.

// What every browser capability falls back to on /capabilities when its card names no glyph of its own.
const BROWSER_GLYPH = `globe`;

export interface BrowserAccount {
    /** The capability id, the account; unique, and what an identity card names. */
    readonly id: string;
    /** The site slug (`reddit`). Shared by every account of that site. */
    readonly platform: string;
    /** The site as a person would name it (`Reddit`), falling back to the slug. */
    readonly site: string;
    readonly logo: string | undefined;
    readonly icon: string;
}

export function useBrowserAccounts() {
    const { capabilities } = useCapabilities();
    const { contributionOf } = useExtensions();

    const accounts = computed<BrowserAccount[]>(() =>
        capabilities.value
            .filter((capability) => capability.kind === `browser`)
            .map((capability) => {
                const platform = typeof capability.config[`platform`] === `string` ? (capability.config[`platform`] as string) : capability.id;
                const card = contributionOf(`browser`, platform)?.catalog;
                return {
                    id: capability.id,
                    platform,
                    site: card?.name ?? platform,
                    logo: card?.logo,
                    icon: card?.icon ?? BROWSER_GLYPH,
                };
            }),
    );

    return {
        accounts,
        // For surfaces that only hold an id and need the account object back.
        accountOf: (id: string): BrowserAccount | undefined => accounts.value.find((account) => account.id === id),
    };
}
