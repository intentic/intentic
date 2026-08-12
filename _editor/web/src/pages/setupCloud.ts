import type { CloudCredentials, CloudProvider, CloudSize } from "@intentic-app/api-contract";

/* The cloud machine choice's own logic — the step-3 alternative for the user (a phone, most often) with no
 * computer to paste the command into: pick a provider, paste a credential, and a machine is created in THEIR
 * cloud account whose first boot runs the same setup code the command lane hands out. Pure data + derivations
 * here, state and calls in SetupCloud.vue — the setupAttach.ts split. */

export interface CloudProviderMeta {
    readonly id: CloudProvider;
    readonly label: string;
    // The one-line pitch under the picker — who this provider is FOR, cost framing included. Prices
    // themselves are never written here: the options call returns them live from the provider's catalog.
    readonly blurb: string;
    // Where the pasted credential comes from, as a "get one" link the user can follow mid-step.
    readonly credentialUrl: string;
    readonly credentialLabel: string;
    // token: one API-token field. oracle: the console's config snippet + the API key PEM, two pastes.
    readonly kind: `token` | `oracle`;
}

export const CLOUD_PROVIDERS: readonly CloudProviderMeta[] = [
    {
        id: `hetzner`,
        label: `Hetzner`,
        blurb: `The budget pick: a machine for a few €/month, billed by Hetzner to you. Prices below are live, excl. VAT.`,
        credentialUrl: `https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/`,
        credentialLabel: `Create a Read & Write API token in your Hetzner Cloud project`,
        kind: `token`,
    },
    {
        id: `digitalocean`,
        label: `DigitalOcean`,
        blurb: `Familiar and everywhere: a droplet billed by DigitalOcean to you. Prices below are live.`,
        credentialUrl: `https://docs.digitalocean.com/reference/api/create-personal-access-token/`,
        credentialLabel: `Create a personal access token with write scope`,
        kind: `token`,
    },
    {
        id: `oracle`,
        label: `Oracle (free)`,
        blurb: `An ARM machine inside Oracle's Always-Free tier, genuinely $0 while you stay within it. Signup asks for a card; free-tier capacity can run short (pick another availability domain and retry).`,
        credentialUrl: `https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm`,
        credentialLabel: `Add an API key under Profile → API keys, then paste the config it shows plus the downloaded key`,
        kind: `oracle`,
    },
];

export const cloudProviderMeta = (id: CloudProvider): CloudProviderMeta =>
    CLOUD_PROVIDERS.find((provider) => provider.id === id) ?? CLOUD_PROVIDERS[0]!;

// The credential the wizard's fields currently amount to, or undefined while incomplete — the gate on both
// the options fetch and the Create button, so no half-pasted credential ever leaves the browser.
export const cloudCredentials = (
    provider: CloudProvider,
    input: { token: string; ociConfig: string; ociKey: string },
): CloudCredentials | undefined => {
    if (provider === `oracle`) {
        const config = input.ociConfig.trim();
        const privateKey = input.ociKey.trim();
        return config === `` || privateKey === `` ? undefined : { provider, config, privateKey };
    }
    const token = input.token.trim();
    return token === `` ? undefined : { provider, token };
};

// "€3.85/mo" — the provider's own number, formatted; the free shape says so instead of showing $0.00.
export const priceLabel = (size: CloudSize): string => {
    if (size.monthlyPrice === 0) {
        return `Free`;
    }
    const symbol = size.currency === `EUR` ? `€` : size.currency === `USD` ? `$` : `${size.currency} `;
    // Trim trailing zeros so Hetzner's 3.85 stays 3.85 while DO's flat 24 stays 24.
    const amount = Number.parseFloat(size.monthlyPrice.toFixed(2));
    return `${symbol}${amount}/mo`;
};

// One line a picker row can carry: what the machine is, then what it costs.
export const sizeLabel = (size: CloudSize): string =>
    `${size.label} · ${size.cpus} vCPU · ${size.memoryGb} GB RAM · ${size.diskGb} GB disk · ${priceLabel(size)}`;
