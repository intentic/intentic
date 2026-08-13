import { ORACLE_CAPACITY_PHRASE, type CloudCredentials, type CloudProvider, type CloudSize } from "@intentic-app/api-contract";

/* The cloud machine choice's own logic — the step-3 alternative for the user (a phone, most often) with no
 * computer to paste the command into: pick a provider, paste a credential, and a machine is created in THEIR
 * cloud account whose first boot runs the same setup code the command lane hands out. Pure data + derivations
 * here, state and calls in SetupCloud.vue — the setupAttach.ts split. */

/* THE PROVIDER'S PITCH IS ITS LABEL AND ITS PRICES, AND NOTHING ELSE. Each of these used to carry a
 * paragraph under the picker — who the provider is for, what the tier costs, how long signing up takes — and
 * every word of it was already on screen: the tab says "Oracle — free 12 GB", the size list under it carries
 * live prices, and the walkthrough's first step says what signing up asks for. Prose that repeats the
 * controls around it is read once, by the person who then has to find the control again. */
export interface CloudProviderMeta {
    readonly id: CloudProvider;
    readonly label: string;
    // Where the pasted credential comes from, as a "get one" link the user can follow mid-step.
    readonly credentialUrl: string;
    readonly credentialLabel: string;
    // token: one API-token field. oracle: the console's config snippet + the API key PEM, two pastes.
    readonly kind: `token` | `oracle`;
}

// Oracle leads: the ladder's flagship rung is the machine that costs nothing — a free 12 GB ARM box — and the
// order here is the order the picker offers. The paid picks follow for readers who want x86 or have an
// account already.
export const CLOUD_PROVIDERS: readonly CloudProviderMeta[] = [
    {
        id: `oracle`,
        label: `Oracle — free 12 GB`,
        credentialUrl: `https://cloud.oracle.com/identity/domains/my-profile/api-keys`,
        credentialLabel: `Add an API key under Profile → API keys`,
        kind: `oracle`,
    },
    {
        id: `hetzner`,
        label: `Hetzner`,
        credentialUrl: `https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/`,
        credentialLabel: `Create a Read & Write API token in your Hetzner Cloud project`,
        kind: `token`,
    },
    {
        id: `digitalocean`,
        label: `DigitalOcean`,
        credentialUrl: `https://docs.digitalocean.com/reference/api/create-personal-access-token/`,
        credentialLabel: `Create a personal access token with write scope`,
        kind: `token`,
    },
];

/* The Oracle walkthrough, click by click — the painful part of the free machine is Oracle's console, so the
 * wizard walks it rather than pointing at docs. Data here, rendered by SetupCloud.vue, so the steps are
 * testable prose rather than template soup.
 *
 * A STEP IS AN INSTRUCTION, NOT AN EXPLANATION. These carried their own parentheses — how long signing up
 * takes, why a card is asked for, what the tier costs — around the one clause that says what to press. Every
 * qualifier is a thing to read before you can act, on the screen where somebody is already three tabs deep in
 * a console they have never seen. Press this, then this, then paste it here. */
export const ORACLE_STEPS: readonly { readonly text: string; readonly url?: string; readonly urlLabel?: string }[] = [
    {
        text: `Sign in to Oracle Cloud, or sign up free.`,
        url: `https://www.oracle.com/cloud/free/`,
        urlLabel: `oracle.com/cloud/free`,
    },
    {
        text: `Press "Add API key" → "Generate API key pair" → download the key → "Add".`,
        url: `https://cloud.oracle.com/identity/domains/my-profile/api-keys`,
        urlLabel: `Profile → API keys`,
    },
    { text: `Paste what Oracle then shows you below: the config preview, then the key file you downloaded.` },
];

// Does this refusal mean "no room right now" rather than "no"? Keyed on the adapter's own phrase (a shared
// contract constant), because this is the one failure worth retrying without the user changing anything —
// which is exactly what the keep-trying loop does.
export const isCapacityMiss = (message: string | undefined): boolean => message !== undefined && message.includes(ORACLE_CAPACITY_PHRASE);

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
