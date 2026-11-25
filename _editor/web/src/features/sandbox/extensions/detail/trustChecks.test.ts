import {
    OFFICIAL_DETERMINISTIC_SCAN_POLICY,
    OFFICIAL_DETERMINISTIC_SCANNER,
    OFFICIAL_DETERMINISTIC_SCANNER_VERSION,
    OFFICIAL_SECURITY_REVIEW_POLICY,
    OFFICIAL_SECURITY_REVIEWER,
    type RegistryEntry,
} from "@intentic/registry";
import type { DiscoverListing } from "../../../../models/sandbox/discoverListing";
import { trustChecksOf, trustScoreOf } from "./trustChecks";

const SHA = `a`.repeat(40);
const URL = `https://github.com/radarsu/intentic-saldeo.git`;

const REVIEW = {
    sha: SHA,
    url: URL,
    policy: OFFICIAL_SECURITY_REVIEW_POLICY,
    reviewer: OFFICIAL_SECURITY_REVIEWER,
    reviewedAt: `2026-11-01T00:00:00.000Z`,
    runId: `905cc314`,
    deterministic: {
        policy: OFFICIAL_DETERMINISTIC_SCAN_POLICY,
        scanner: OFFICIAL_DETERMINISTIC_SCANNER,
        version: OFFICIAL_DETERMINISTIC_SCANNER_VERSION,
        runId: `36941200498`,
    },
};

const listing = (over: Partial<RegistryEntry> = {}): DiscoverListing => ({
    entry: { name: `intentic.saldeo`, kind: `extension`, trust: `listed`, admitted: true, install: { url: URL, ref: SHA }, ...over },
    state: { kind: `installable`, action: `Install` },
    search: ``,
});

const held = (checks: ReturnType<typeof trustChecksOf>): string[] => checks.filter((check) => check.passed).map((check) => check.id);
const gaps = (checks: ReturnType<typeof trustChecksOf>): string[] => checks.filter((check) => !check.passed).map((check) => check.id);

describe(`what installing a listing would trust`, () => {
    test(`an audited, human-read, pinned commit that loads holds every guarantee but browser isolation`, () => {
        const checks = trustChecksOf(listing({ trust: `verified`, securityReview: REVIEW, checks: { sha: SHA, manifest: `ok`, bundle: `ok` } }));
        expect(held(checks)).toEqual([`scan`, `audit`, `human`, `pinned`, `loads`]);
        expect(gaps(checks)).toEqual([`isolation`]);
        // Isolation is missing for every extension, so it says nothing about this one and stays out of the score.
        expect(trustScoreOf(checks)).toEqual({ passed: 5, total: 5 });
    });

    test(`a listing nobody vouched for shows both gaps, and the scan line says what ran`, () => {
        const checks = trustChecksOf(listing({ securityReview: REVIEW }));
        expect(gaps(checks)).toEqual([`human`, `isolation`]);
        expect(checks.find((check) => check.id === `scan`)?.detail).toContain(`trivy 0.72.0`);
        expect(trustScoreOf(checks)).toEqual({ passed: 3, total: 4 });
    });

    test(`an audit of another commit is no cover: one gap, not two passes`, () => {
        const checks = trustChecksOf(listing({ securityReview: { ...REVIEW, sha: `b`.repeat(40) } }));
        expect(checks.filter((check) => check.id === `scan`)).toEqual([]);
        expect(checks.find((check) => check.id === `audit`)?.passed).toBe(false);
    });

    test(`no nightly scan is silence, a failed one is a gap with the scan's own words`, () => {
        expect(trustChecksOf(listing()).some((check) => check.id === `loads`)).toBe(false);
        const failed = trustChecksOf(listing({ checks: { sha: SHA, manifest: `engines range is not valid semver`, bundle: `ok` } }));
        const loads = failed.find((check) => check.id === `loads`);
        expect(loads?.passed).toBe(false);
        expect(loads?.detail).toContain(`engines range is not valid semver`);
    });

    test(`a listing with no pinned commit claims no pin`, () => {
        expect(trustChecksOf(listing({ install: { url: URL } })).some((check) => check.id === `pinned`)).toBe(false);
    });
});
