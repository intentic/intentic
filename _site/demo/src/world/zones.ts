// THE ACCOUNT'S DOMAINS ON CLOUDFLARE, as a pasted API token sees them: the two the shop's fixture already names
// (its own site and the team's), listed after the round trip a real listing takes. The platform asks Cloudflare once
// with the token and drops it; so does this, since nothing here keeps it.

const ZONES = [`acme.dev`, `acme-shop.com`];
const LISTING_MS = 700;

// A token Cloudflare would refuse outright: the dashboard's own placeholder, which a paste of the example leaves.
const PLACEHOLDER = /^(x+|your[-_]?token.*)$/i;

/** The zones a token can see; empty for one Cloudflare would answer with nothing it may read. */
export const zonesFor = async (token: string): Promise<string[]> => {
    await new Promise((resolve) => setTimeout(resolve, LISTING_MS));
    return PLACEHOLDER.test(token.trim()) ? [] : [...ZONES];
};
