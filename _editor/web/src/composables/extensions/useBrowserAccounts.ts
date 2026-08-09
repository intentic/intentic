import { computed } from "vue";
import { useCapabilities } from "./useCapabilities";
import { useExtensions } from "./useExtensions";

/* THE LOGGED-IN BROWSER ACCOUNTS, DRESSED FOR DISPLAY — one entry per connection, carrying the brand its site
 * is known by rather than the slug the manifest stores it under.
 *
 * A browser capability's id is the ACCOUNT (`reddit-work`) and its `platform` is the SITE (`reddit`), and only
 * the site has a logo — so the two have to be carried separately: a row that drew `reddit-work` against
 * Reddit's mark would be right about the picture and wrong about which account it stands for.
 *
 * The brand comes from the same place /capabilities gets it (the enabled extensions' contributed cards), so an
 * account wears one mark across the app instead of one here and another there. Everything is optional the whole
 * way down — <BrandMark> falls to the glyph and then to initials — which is what makes it safe to ask a
 * manifest that may not have loaded yet, or may describe a site this build has never heard of. */

// What every browser capability falls back to on /capabilities when its card names no glyph of its own.
const BROWSER_GLYPH = `globe`;

export interface BrowserAccount {
    /** The capability id — the ACCOUNT. Unique, and what an identity card names. */
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
        // For the surfaces that hold an id and need the account back — a card names ids, not objects.
        accountOf: (id: string): BrowserAccount | undefined => accounts.value.find((account) => account.id === id),
    };
}
