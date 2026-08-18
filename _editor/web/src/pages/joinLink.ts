/* THE TWO PURE HALVES OF JOINING BY LINK: reading what the link says, and saying what the box answered.
 *
 * Out of the page component because both are rules rather than rendering — the fragment shape is a contract
 * with whoever built the link, and the refusals are the only words a visitor ever gets when something is
 * wrong. Neither can be checked by looking at a screenshot of the happy path, and both are exactly the kind
 * of thing that rots quietly. */

export interface JoinLink {
    // The box's origin, normalized — what /join is appended to.
    readonly daemonUrl: string;
    readonly secret: string;
}

/* Read `#s=<box origin>&k=<secret>`.
 *
 * THE FRAGMENT, NOT THE QUERY, and that is a security property rather than a style: a fragment is never sent
 * to a server, so the secret stays out of this app's access logs, out of any proxy in front of it, and out of
 * the Referer header of every request the page makes afterwards.
 *
 * https ONLY. The Google credential and the daemon session both cross this hop, so a link naming a plain-http
 * box would put them on the wire in the clear — and a link that arrives that way is far more likely to have
 * been mangled than to be someone's deliberate choice. */
export const readJoinLink = (hash: string): JoinLink | undefined => {
    const params = new URLSearchParams(hash.replace(/^#/, ``));
    const address = params.get(`s`) ?? ``;
    const secret = params.get(`k`) ?? ``;
    if (address === `` || secret === ``) {
        return undefined;
    }
    try {
        const url = new URL(address);
        return url.protocol === `https:` ? { daemonUrl: url.origin, secret } : undefined;
    } catch {
        return undefined;
    }
};

/* What the box's refusal means to the person holding the link. Every one of these ends in the same action —
 * ask for a new link — because that IS the fix in every case; what changes is whether they should expect one
 * to work, which is why the causes are kept apart rather than collapsed into a single "this didn't work". */
export const joinRefusal = (status: number, reason: string): string => {
    if (status === 404 && reason === `unknown`) {
        return `This link does not work any more — it was revoked, or it was never a link for this sandbox. Ask whoever sent it for a new one.`;
    }
    if (status === 410) {
        return reason === `full`
            ? `This link has already been used by as many people as it was meant for. Ask whoever sent it for a new one.`
            : `This link has expired. Ask whoever sent it for a new one.`;
    }
    if (status === 409) {
        return `This sandbox has no owner yet, so it cannot let anyone in. Whoever sent the link needs to open it themselves once first.`;
    }
    if (status === 401) {
        return `That sign-in could not be verified. Try again, and make sure you are using the Google account you were invited as.`;
    }
    if (status === 404) {
        return `This sandbox does not accept join links.`;
    }
    return `The sandbox refused the link (${status}).`;
};
