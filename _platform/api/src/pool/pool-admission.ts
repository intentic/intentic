import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Config } from "../config.js";
import { forwardToService } from "./pool-services.js";

/* OPEN ADMISSION, the published algorithm that replaced "an operator writes the row after a Discord chat".
 *
 * The member's safety never came from curation. It comes from the spend gate in the sandbox
 * (platform/service-offer.ts): the agent cannot spend, one click releases exactly one run, every number on the
 * card is the platform's own, and a run that fails to answer is refunded before a receipt exists. A hostile
 * listing's whole reach is a few small, individually-approved, refundable charges, and it ships no
 * code to anyone, because a service is an endpoint rather than a bundle.
 *
 * That leaves review guarding three mechanical questions, which is what this module answers:
 *   1. IDENTITY , a claimed publisher name plus a payout-ready account (both already exist, creator/*).
 *   2. CONFORMANCE, a live probe the provider's endpoint must pass, INCLUDING refusing forged calls.
 *   3. LISTING RULES, bounded fields, a price band, reserved words, a reachable public https endpoint.
 * What is left over, "is the answer any good", is not knowable at admission by anyone, so it is not asked
 * here. pool-watch.ts asks it afterwards, out of behaviour, which is a service's only artifact.
 *
 * Every threshold is config (config.ts pool.*), never a constant: a rule a provider cannot look up in advance
 * is a human review wearing a constant's clothes, and the entire point was to stop having one. */

export type ServiceStatus = `draft` | `probation` | `listed` | `suspended`;

// The statuses a member's catalog read and a metered run accept. `draft` is invisible and `suspended` is
// delisted; both keep their rows and their run history.
export const LIVE_STATUSES: readonly ServiceStatus[] = [`probation`, `listed`];

/* ── Gate 3: the listing rules ────────────────────────────────────────────────────────────────────────── */

// Words a listing may not wear unless the platform itself published it, the whole of what "impersonation"
// means on a surface whose only prose is a name and one description. Exported because a domain claim
// (creator/creator-claim.ts) refuses the same words for the same reason: a claimed domain becomes a
// publisher name every card shows.
export const RESERVED_WORDS = [`intentic`, `official`, `verified`];
const PLATFORM_PUBLISHER = `intentic`;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const NAME_MIN = 3;
const NAME_MAX = 60;
const DESCRIPTION_MIN = 40;
const DESCRIPTION_MAX = 400;
const SAMPLE_MAX = 4_000;

export interface ListingInput {
    readonly slug: string;
    readonly publisher: string;
    readonly name: string;
    readonly description: string;
    readonly upstreamUrl: string;
    readonly creditsPerRun: number;
    readonly sampleRequest: string;
}

/* Every problem with a listing, in one pass rather than one per round trip. A provider fixing four things
 * should learn all four at once, the alternative is four submissions to discover what a published rule
 * could have told them before the first. */
export const checkListingRules = (config: Config, input: ListingInput): readonly string[] => {
    const problems: string[] = [];
    const reserved = (text: string): boolean =>
        input.publisher !== PLATFORM_PUBLISHER && RESERVED_WORDS.some((word) => text.toLowerCase().includes(word));

    if (!SLUG_RE.test(input.slug) || input.slug.length > 64) {
        problems.push(`The slug must be lowercase letters, digits and dashes, starting with a letter or digit, up to 64 characters.`);
    }
    if (reserved(input.slug)) {
        problems.push(`The slug may not contain ${RESERVED_WORDS.join(`, `)} — those words are reserved for the platform's own listings.`);
    }
    if (input.name.trim().length < NAME_MIN || input.name.length > NAME_MAX) {
        problems.push(`The name must be between ${NAME_MIN} and ${NAME_MAX} characters.`);
    }
    if (reserved(input.name)) {
        problems.push(`The name may not contain ${RESERVED_WORDS.join(`, `)}.`);
    }
    if (input.description.trim().length < DESCRIPTION_MIN || input.description.length > DESCRIPTION_MAX) {
        problems.push(
            `The description must be between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX} characters — it is the only prose a member reads before paying.`,
        );
    }
    if (reserved(input.description)) {
        problems.push(`The description may not contain ${RESERVED_WORDS.join(`, `)}.`);
    }
    if (!Number.isInteger(input.creditsPerRun) || input.creditsPerRun < config.pool.serviceMinCredits || input.creditsPerRun > config.pool.serviceMaxCredits) {
        problems.push(`The price must be a whole number of credits between ${config.pool.serviceMinCredits} and ${config.pool.serviceMaxCredits}.`);
    }
    if (input.sampleRequest.length > SAMPLE_MAX) {
        problems.push(`The sample request must be under ${SAMPLE_MAX} characters.`);
    } else {
        try {
            JSON.parse(input.sampleRequest);
        } catch {
            problems.push(`The sample request must be valid JSON — it is the body the conformance probe sends.`);
        }
    }
    const urlProblem = checkUpstreamShape(input.upstreamUrl);
    if (urlProblem !== undefined) {
        problems.push(urlProblem);
    }
    /* A DOTTED PUBLISHER IS A DOMAIN (the claim's discriminator, creator-claim.ts), and its endpoint must
     * live under it. This is what makes a domain claim mean something for a listing: the name on the card
     * and the host that serves the runs are provably the same party, checked here syntactically so the rule
     * is readable in advance like every other one. Registry-claimed (dotless) publishers are untouched,
     * their proof is a repository, and their endpoints host wherever they like. */
    if (input.publisher.includes(`.`) && urlProblem === undefined) {
        const host = new URL(input.upstreamUrl).hostname.toLowerCase();
        if (host !== input.publisher && !host.endsWith(`.${input.publisher}`)) {
            problems.push(`A domain publisher's endpoint must live under its own domain: ${input.publisher} may only list endpoints on ${input.publisher} or its subdomains.`);
        }
    }
    return problems;
};

// Private space, in the four forms a provider's DNS could hand back. Not a security boundary by itself,
// see resolvesPublicly below for why the name check and the address check are both here.
const isPrivateAddress = (address: string): boolean => {
    if (isIP(address) === 6) {
        const lower = address.toLowerCase();
        return lower === `::1` || lower.startsWith(`fc`) || lower.startsWith(`fd`) || lower.startsWith(`fe80`) || lower.startsWith(`::ffff:`);
    }
    const [a = 0, b = 0] = address.split(`.`).map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
};

const checkUpstreamShape = (raw: string): string | undefined => {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return `The endpoint must be an absolute URL.`;
    }
    if (url.protocol !== `https:`) {
        return `The endpoint must be https — a forwarded call carries a signature and a member's request.`;
    }
    const host = url.hostname.toLowerCase();
    if (host === `localhost` || host.endsWith(`.local`) || host.endsWith(`.internal`) || (isIP(host) !== 0 && isPrivateAddress(host))) {
        return `The endpoint must be a public host — the platform calls it from its own network, not from yours.`;
    }
    return undefined;
};

/* The endpoint's name must resolve, and resolve to public space. This is checked at publish and at every
 * canary rather than at forward time, so it is a LISTING rule and not an SSRF defence: a name that resolves
 * publicly now can point somewhere else in a second, and the honest mitigation for that is the platform's own
 * egress policy, not a check here. What this does buy is that a provider cannot list `internal.corp` and have
 * the platform quietly probing someone's private network on their behalf. Exported for the domain claim
 * (creator/creator-claim.ts), whose well-known read is the same shape of platform-initiated fetch. */
export const resolvesPublicly = async (
    upstreamUrl: string,
    lookupFn: typeof lookup,
): Promise<string | undefined> => {
    const host = new URL(upstreamUrl).hostname;
    if (isIP(host) !== 0) {
        return isPrivateAddress(host) ? `The endpoint resolves to a private address.` : undefined;
    }
    try {
        const addresses = await lookupFn(host, { all: true });
        if (addresses.length === 0) {
            return `The endpoint's hostname does not resolve.`;
        }
        return addresses.some((entry) => isPrivateAddress(entry.address)) ? `The endpoint resolves to a private address.` : undefined;
    } catch {
        return `The endpoint's hostname does not resolve.`;
    }
};

/* ── Gate 2: the conformance probe ────────────────────────────────────────────────────────────────────── */

export interface ProbeCheck {
    readonly name: `serves` | `rejectsForgery` | `rejectsReplay`;
    readonly passed: boolean;
    readonly detail: string;
}

export interface ProbeVerdict {
    readonly passed: boolean;
    readonly checks: readonly ProbeCheck[];
}

// How far back the replay probe's timestamp is stamped, comfortably outside pool-services.ts's own
// five-minute tolerance, so a provider implementing the documented check refuses it without ambiguity.
const REPLAY_AGE_S = 3_600;

// A forged signature: the right shape and the wrong bytes, so a provider comparing lengths first still
// reaches the comparison this is meant to fail.
const FORGED_SIGNATURE = `0`.repeat(64);

const PROBE_TIMEOUT_MS = 30_000;

// One deliberately-bad call. Anything that is not a 2xx is a pass, including a connection error, which is
// the bluntest possible refusal and refuses the forgery just as effectively as a 401 does.
const expectRefusal = async (
    upstreamUrl: string,
    headers: Record<string, string>,
    body: string,
    fetchFn: typeof fetch,
): Promise<{ passed: boolean; detail: string }> => {
    try {
        const response = await fetchFn(upstreamUrl, {
            method: `POST`,
            headers: { "content-type": `application/json`, ...headers },
            body,
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        // Drain rather than leave a socket half-read; the body is never inspected.
        await response.text().catch(() => ``);
        return response.status >= 200 && response.status < 300
            ? { passed: false, detail: `answered ${response.status} — the call should have been refused` }
            : { passed: true, detail: `refused with ${response.status}` };
    } catch {
        return { passed: true, detail: `refused the connection` };
    }
};

/* THE PROBE. Three calls, all of which must pass, none of which costs anyone a credit.
 *
 * `serves` goes through forwardToService, the REAL forward a paid run takes, not a reimplementation of it,
 * so what conformance means here cannot drift from what the metered path actually does. The other two prove
 * the endpoint VERIFIES, which is the only reason the signature exists: an endpoint that answers a forged
 * call can be billed by anyone on the internet against the provider's own upstream costs, and listing it
 * would be doing the provider harm. */
export const probeService = async (
    upstreamUrl: string,
    secret: string,
    sampleRequest: string,
    fetchFn: typeof fetch = fetch,
    now: () => Date = () => new Date(),
    lookupFn: typeof lookup = lookup,
): Promise<ProbeVerdict> => {
    const shape = checkUpstreamShape(upstreamUrl) ?? (await resolvesPublicly(upstreamUrl, lookupFn));
    if (shape !== undefined) {
        return { passed: false, checks: [{ name: `serves`, passed: false, detail: shape }] };
    }
    const serves = await (async (): Promise<ProbeCheck> => {
        const outcome = await forwardToService(upstreamUrl, secret, sampleRequest, fetchFn, now);
        if (outcome.kind === `failed`) {
            return { name: `serves`, passed: false, detail: `did not answer — a 5xx, a timeout, or a dead socket` };
        }
        if (outcome.kind === `answered`) {
            return {
                name: `serves`,
                passed: false,
                detail: `answered ${outcome.status} to its own sample request — the probe body must be one the service serves`,
            };
        }
        // Drain the stream; its RETURN value is the verdict, true iff a `result` arrived.
        let served = false;
        try {
            while (true) {
                const next = await outcome.events.next();
                if (next.done) {
                    served = next.value;
                    break;
                }
            }
        } catch {
            served = false;
        }
        return served
            ? { name: `serves`, passed: true, detail: `streamed a result` }
            : { name: `serves`, passed: false, detail: `the stream ended without a result, or broke the event format` };
    })();

    const at = Math.floor(now().getTime() / 1000);
    const forgery = await expectRefusal(
        upstreamUrl,
        { "x-intentic-timestamp": String(at), "x-intentic-signature": FORGED_SIGNATURE },
        sampleRequest,
        fetchFn,
    );
    const stale = at - REPLAY_AGE_S;
    const replay = await expectRefusal(
        upstreamUrl,
        {
            "x-intentic-timestamp": String(stale),
            "x-intentic-signature": createHmac(`sha256`, secret).update(`${stale}.${sampleRequest}`).digest(`hex`),
        },
        sampleRequest,
        fetchFn,
    );
    const checks: readonly ProbeCheck[] = [
        serves,
        { name: `rejectsForgery`, ...forgery },
        { name: `rejectsReplay`, ...replay },
    ];
    return { passed: checks.every((check) => check.passed), checks };
};

// The first failing check's sentence, what a provider is shown, and what a suspension records.
export const probeFailure = (verdict: ProbeVerdict): string => {
    const failed = verdict.checks.find((check) => !check.passed);
    if (failed === undefined) {
        return `passed`;
    }
    const what = {
        serves: `Your endpoint did not serve its own sample request`,
        rejectsForgery: `Your endpoint accepted a call with a forged signature`,
        rejectsReplay: `Your endpoint accepted a call with an expired timestamp`,
    }[failed.name];
    return `${what}: ${failed.detail}.`;
};

/* ── Gate 1 + the whole decision ──────────────────────────────────────────────────────────────────────── */

export interface AdmissionDeps {
    // Does this account hold a claim on this publisher name (creator/creator-claim.ts wrote it)?
    readonly holdsPublisher: (userId: string, publisher: string) => Promise<boolean>;
    // Are payouts enabled on this account (creator/creator-payouts.ts reads it through to Stripe)?
    readonly payoutsEnabled: (userId: string) => Promise<boolean>;
    // How many live listings this account already holds.
    readonly liveServiceCount: (userId: string) => Promise<number>;
}

export type GateVerdict = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

/* The gates a draft must clear to go live, evaluated in cost order: the free local checks first, the Stripe
 * read last, so a listing with four rule problems never spends a network call to learn it also needs payouts.
 *
 * The probe is NOT run here. It is its own call the provider makes when they are ready, because it hits their
 * endpoint and they should be the one choosing when, publish only checks that a passing one is recent. */
export const publishGates = async (
    deps: AdmissionDeps,
    config: Config,
    userId: string,
    listing: ListingInput & { readonly status: ServiceStatus; readonly probedAt: Date | null },
    now: Date,
): Promise<GateVerdict> => {
    const problems = [...checkListingRules(config, listing)];
    if (listing.creditsPerRun > config.pool.probationMaxCredits && listing.status !== `listed`) {
        problems.push(
            `A new listing starts on probation, where the price ceiling is ${config.pool.probationMaxCredits} credits. It lifts once the listing has served ${config.pool.graduationRuns} runs.`,
        );
    }
    const freshUntil = listing.probedAt === null ? 0 : listing.probedAt.getTime() + config.pool.probeFreshMinutes * 60_000;
    if (freshUntil < now.getTime()) {
        problems.push(
            `Run the conformance probe first — a passing probe is good for ${config.pool.probeFreshMinutes} minutes, because its whole claim is that the endpoint works right now.`,
        );
    }
    if (problems.length > 0) {
        return { ok: false, problems };
    }
    if (!(await deps.holdsPublisher(userId, listing.publisher))) {
        return {
            ok: false,
            problems: [`You have not proved that ${listing.publisher} is yours. Settings → Payouts walks through claiming a publisher name.`],
        };
    }
    if ((await deps.liveServiceCount(userId)) >= config.pool.maxServicesPerOwner) {
        return { ok: false, problems: [`You already hold ${config.pool.maxServicesPerOwner} live listings, which is the limit per account.`] };
    }
    if (!(await deps.payoutsEnabled(userId))) {
        return {
            ok: false,
            problems: [`Payouts are not enabled on your account yet. A listing has to be able to be paid before it can be offered.`],
        };
    }
    return { ok: true };
};
