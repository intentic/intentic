import { createHmac } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import { checkListingRules, probeFailure, probeService, publishGates, type AdmissionDeps, type ListingInput } from "./pool-admission.js";

/* The admission gates, driven without a network, a Stripe account or a provider. Every threshold here is the
 * shipped default, so a test that starts failing because someone moved one is telling the truth: these are
 * published numbers, and moving one is a change to the promise, not to an implementation detail. */

const config = {
    pool: {
        serviceMinCredits: 1,
        serviceMaxCredits: 200,
        probationMaxCredits: 25,
        probeFreshMinutes: 60,
        graduationRuns: 50,
        maxRefundRate: 0.2,
        watchWindowRuns: 20,
        canaryFailures: 3,
        priceChangeHours: 24,
        maxServicesPerOwner: 5,
        openAdmission: true,
    },
} as Config;

const LISTING: ListingInput = {
    slug: `acme-research`,
    publisher: `acme`,
    name: `Acme Research`,
    description: `Deep research across two hundred communities, ranked and summarised for a launch plan.`,
    upstreamUrl: `https://svc.acme.test/run`,
    creditsPerRun: 10,
    sampleRequest: `{"query":"where should we launch?"}`,
};

const SECRET = `probe-secret`;
const NOW = new Date(`2026-08-17T12:00:00.000Z`);

// DNS that answers public space for everything: the resolve check has its own tests below.
const publicLookup = vi.fn(async () => [{ address: `93.184.216.34`, family: 4 }] as LookupAddress[]) as unknown as typeof import("node:dns/promises").lookup;

const ndjson = (): string =>
    `${JSON.stringify({ event: `status`, text: `working` })}\n${JSON.stringify({ event: `result`, data: { ok: true } })}\n`;

const signatureOf = (timestamp: string, body: string): string => createHmac(`sha256`, SECRET).update(`${timestamp}.${body}`).digest(`hex`);

/* A provider that implements the documented contract correctly: it verifies the signature and the timestamp,
 * refuses anything that fails either, and streams status lines then one result. The knobs are what each test
 * breaks to prove the probe notices. */
const provider = (broken: { acceptsForgery?: boolean; acceptsReplay?: boolean; neverResults?: boolean; dead?: boolean } = {}): typeof fetch =>
    (async (_url: string, init: RequestInit) => {
        if (broken.dead === true) {
            return new Response(`upstream on fire`, { status: 503 });
        }
        const headers = new Headers(init.headers);
        const timestamp = headers.get(`x-intentic-timestamp`) ?? ``;
        const signature = headers.get(`x-intentic-signature`) ?? ``;
        const body = String(init.body ?? ``);
        const signed = signature === signatureOf(timestamp, body);
        const fresh = Math.abs(NOW.getTime() / 1000 - Number(timestamp)) <= 300;
        if (!signed && broken.acceptsForgery !== true) {
            return new Response(`bad signature`, { status: 401 });
        }
        if (!fresh && broken.acceptsReplay !== true) {
            return new Response(`stale`, { status: 401 });
        }
        const stream = broken.neverResults === true ? `${JSON.stringify({ event: `status`, text: `working` })}\n` : ndjson();
        return new Response(stream, { status: 200, headers: { "content-type": `application/x-ndjson` } });
    }) as unknown as typeof fetch;

describe(`the listing rules`, () => {
    it(`passes a listing that meets every published bound`, () => {
        expect(checkListingRules(config, LISTING)).toEqual([]);
    });

    /* All problems at once, not the first. A provider fixing four things should learn all four in one round
     * trip: the alternative is four submissions to discover what a published rule could have told them. */
    it(`reports every problem together rather than the first one`, () => {
        const problems = checkListingRules(config, {
            ...LISTING,
            slug: `Acme Research`,
            name: `x`,
            description: `too short`,
            creditsPerRun: 5_000,
        });
        expect(problems.length).toBe(4);
    });

    it(`refuses reserved words to anyone but the platform, and allows them to it`, () => {
        expect(checkListingRules(config, { ...LISTING, name: `Official Acme Research` })).toContainEqual(expect.stringContaining(`may not contain`));
        expect(checkListingRules(config, { ...LISTING, publisher: `intentic`, slug: `intentic-demo`, name: `Official Demo Research` })).toEqual([]);
    });

    it(`refuses an endpoint that is not public https`, () => {
        expect(checkListingRules(config, { ...LISTING, upstreamUrl: `http://svc.acme.test/run` })).toContainEqual(expect.stringContaining(`https`));
        expect(checkListingRules(config, { ...LISTING, upstreamUrl: `https://localhost/run` })).toContainEqual(expect.stringContaining(`public host`));
        expect(checkListingRules(config, { ...LISTING, upstreamUrl: `https://10.1.2.3/run` })).toContainEqual(expect.stringContaining(`public host`));
    });

    it(`refuses a sample request that is not JSON, because it is the probe's body`, () => {
        expect(checkListingRules(config, { ...LISTING, sampleRequest: `not json` })).toContainEqual(expect.stringContaining(`valid JSON`));
    });

    /* A dotted publisher is a domain-claimed one (creator-claim.ts), and the claim only means something if
     * the endpoint serving the runs lives under the name on the card. Registry publishers host anywhere. */
    it(`ties a domain publisher's endpoint to its own domain, and only theirs`, () => {
        const domain = { ...LISTING, publisher: `acme.dev` };
        expect(checkListingRules(config, { ...domain, upstreamUrl: `https://acme.dev/run` })).toEqual([]);
        expect(checkListingRules(config, { ...domain, upstreamUrl: `https://api.acme.dev/run` })).toEqual([]);
        expect(checkListingRules(config, { ...domain, upstreamUrl: `https://svc.other.test/run` })).toContainEqual(
            expect.stringContaining(`must live under its own domain`),
        );
        // The suffix has to be a label boundary: notacme.dev is somebody else entirely.
        expect(checkListingRules(config, { ...domain, upstreamUrl: `https://notacme.dev/run` })).toContainEqual(
            expect.stringContaining(`must live under its own domain`),
        );
        // A registry (dotless) publisher keeps hosting wherever it likes.
        expect(checkListingRules(config, { ...LISTING, upstreamUrl: `https://svc.other.test/run` })).toEqual([]);
    });
});

describe(`the conformance probe`, () => {
    it(`passes an endpoint that serves and refuses both bad calls`, async () => {
        const verdict = await probeService(LISTING.upstreamUrl, SECRET, LISTING.sampleRequest, provider(), () => NOW, publicLookup);
        expect(verdict.passed).toBe(true);
        expect(verdict.checks.map((check) => check.name)).toEqual([`serves`, `rejectsForgery`, `rejectsReplay`]);
    });

    /* The two checks that are the whole reason the signature exists. An endpoint that answers a forged call
     * can be billed by anyone on the internet against the provider's own upstream costs: listing it would be
     * doing the provider harm, so it is not admitted however well it serves. */
    it(`fails an endpoint that answers a forged signature`, async () => {
        const verdict = await probeService(
            LISTING.upstreamUrl,
            SECRET,
            LISTING.sampleRequest,
            provider({ acceptsForgery: true }),
            () => NOW,
            publicLookup,
        );
        expect(verdict.passed).toBe(false);
        expect(probeFailure(verdict)).toContain(`forged signature`);
    });

    it(`fails an endpoint that answers an expired timestamp`, async () => {
        const verdict = await probeService(
            LISTING.upstreamUrl,
            SECRET,
            LISTING.sampleRequest,
            provider({ acceptsReplay: true }),
            () => NOW,
            publicLookup,
        );
        expect(verdict.passed).toBe(false);
        expect(probeFailure(verdict)).toContain(`expired timestamp`);
    });

    it(`fails a stream that never reaches its result`, async () => {
        const verdict = await probeService(
            LISTING.upstreamUrl,
            SECRET,
            LISTING.sampleRequest,
            provider({ neverResults: true }),
            () => NOW,
            publicLookup,
        );
        expect(verdict.passed).toBe(false);
        expect(probeFailure(verdict)).toContain(`did not serve`);
    });

    it(`fails an endpoint that is not answering at all`, async () => {
        const verdict = await probeService(LISTING.upstreamUrl, SECRET, LISTING.sampleRequest, provider({ dead: true }), () => NOW, publicLookup);
        expect(verdict.passed).toBe(false);
    });

    // The listing rule catches a private literal; this catches a public NAME that resolves into private space,
    // which is the only version a provider could file by accident or on purpose.
    it(`fails a hostname that resolves into private space`, async () => {
        const privateLookup = vi.fn(async () => [{ address: `10.0.0.5`, family: 4 }] as LookupAddress[]) as unknown as typeof import(
            "node:dns/promises"
        ).lookup;
        const verdict = await probeService(LISTING.upstreamUrl, SECRET, LISTING.sampleRequest, provider(), () => NOW, privateLookup);
        expect(verdict.passed).toBe(false);
        expect(probeFailure(verdict)).toContain(`private address`);
    });
});

describe(`the publish gates`, () => {
    const deps = (over: Partial<AdmissionDeps> = {}): AdmissionDeps => ({
        holdsPublisher: async () => true,
        payoutsEnabled: async () => true,
        liveServiceCount: async () => 0,
        ...over,
    });
    const draft = { ...LISTING, status: `draft` as const, probedAt: new Date(NOW.getTime() - 60_000) };

    it(`admits a draft that holds its name, is payable, and probed recently`, async () => {
        await expect(publishGates(deps(), config, `user-1`, draft, NOW)).resolves.toEqual({ ok: true });
    });

    it(`refuses a probe older than the freshness window`, async () => {
        const stale = { ...draft, probedAt: new Date(NOW.getTime() - 2 * 3_600_000) };
        const verdict = await publishGates(deps(), config, `user-1`, stale, NOW);
        expect(verdict).toMatchObject({ ok: false });
        expect(verdict.ok === false && verdict.problems[0]).toContain(`conformance probe`);
    });

    it(`holds a new listing under the probation price ceiling`, async () => {
        const dear = { ...draft, creditsPerRun: 100 };
        const verdict = await publishGates(deps(), config, `user-1`, dear, NOW);
        expect(verdict.ok === false && verdict.problems[0]).toContain(`probation`);
    });

    /* Cost order matters: a listing with rule problems must not spend a Stripe read to also learn about
     * payouts, and a provider must not be told "connect payouts" when the real blocker was a typo. */
    it(`answers rule problems without reaching for the identity gates`, async () => {
        const payoutsEnabled = vi.fn(async () => true);
        const holdsPublisher = vi.fn(async () => true);
        await publishGates(deps({ payoutsEnabled, holdsPublisher }), config, `user-1`, { ...draft, name: `x` }, NOW);
        expect(payoutsEnabled).not.toHaveBeenCalled();
        expect(holdsPublisher).not.toHaveBeenCalled();
    });

    it(`refuses an unclaimed publisher name`, async () => {
        const verdict = await publishGates(deps({ holdsPublisher: async () => false }), config, `user-1`, draft, NOW);
        expect(verdict.ok === false && verdict.problems[0]).toContain(`not proved`);
    });

    it(`refuses an account that cannot be paid`, async () => {
        const verdict = await publishGates(deps({ payoutsEnabled: async () => false }), config, `user-1`, draft, NOW);
        expect(verdict.ok === false && verdict.problems[0]).toContain(`Payouts are not enabled`);
    });

    it(`refuses an account already at the listing cap`, async () => {
        const verdict = await publishGates(deps({ liveServiceCount: async () => 5 }), config, `user-1`, draft, NOW);
        expect(verdict.ok === false && verdict.problems[0]).toContain(`limit per account`);
    });
});
