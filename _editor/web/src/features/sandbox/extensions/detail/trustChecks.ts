import { isCurrentSecurityReview } from "@intentic/registry";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { checksOk, checksProblem, type DiscoverListing } from "../../../../models/sandbox/discoverListing";

// What installing a listing would trust, one guarantee per line, each either held or not: the scanner, the agent gate,
// a human's read, the pinned commit, the nightly load and the browser's lack of isolation, ordered by who answers for
// each. A line is a title and a few words; the run that backs it and the longer account wait behind its (i).

export interface TrustCheck {
    readonly id: `scan` | `audit` | `human` | `pinned` | `loads` | `isolation`;
    readonly passed: boolean;
    readonly icon: IconName;
    readonly title: string;
    readonly detail?: string | undefined;
    /** The longer account, for whoever opens the line's (i). */
    readonly why?: string | undefined;
    /** Counted toward the page's meter. False for a fact true of every extension, which says nothing about this one. */
    readonly counted: boolean;
}

const auditChecks = (listing: DiscoverListing): TrustCheck[] => {
    const review = listing.entry.securityReview;
    if (review === undefined) {
        return [
            {
                id: `audit`,
                passed: false,
                counted: true,
                icon: `shield`,
                title: t(`sandbox.discoverDetail.noSecurityAuditRecord`),
                detail: t(`sandbox.discoverDetail.noAutomatedChecks`),
            },
        ];
    }
    // An audit record for an older commit, or under an older policy, is no cover for this one.
    if (!isCurrentSecurityReview(review, listing.entry.install)) {
        return [
            {
                id: `audit`,
                passed: false,
                counted: true,
                icon: `shield`,
                title: t(`sandbox.discoverDetail.securityAuditOutOfDate`),
                detail: t(`sandbox.discoverDetail.auditNotThisCommit`),
            },
        ];
    }
    return [
        {
            id: `scan`,
            passed: true,
            counted: true,
            icon: `shield`,
            title: t(`sandbox.discoverDetail.deterministicScan`),
            detail: t(`sandbox.discoverDetail.scanClean`, { scanner: `${review.deterministic.scanner} ${review.deterministic.version}` }),
            why: t(`sandbox.discoverDetail.workflowRun`, { runId: review.deterministic.runId }),
        },
        {
            id: `audit`,
            passed: true,
            counted: true,
            icon: `robot`,
            title: t(`sandbox.discoverDetail.agentSecurityAudit`),
            detail: `${review.reviewer} · ${review.policy}`,
            why: t(`sandbox.discoverDetail.gateRun`, { runId: review.runId }),
        },
    ];
};

// Evidence, not endorsement, and silent when there is none: a registry with no scanner hasn't failed a check.
const loadCheck = (listing: DiscoverListing): TrustCheck[] => {
    if (checksOk(listing.entry)) {
        return [
            {
                id: `loads`,
                passed: true,
                counted: true,
                icon: `check-circle`,
                title: t(`sandbox.discoverDetail.loadsAtCommit`),
                detail: t(`sandbox.discoverDetail.nightlyScan`),
            },
        ];
    }
    const problem = checksProblem(listing.entry);
    return problem === undefined
        ? []
        : [
              {
                  id: `loads`,
                  passed: false,
                  counted: true,
                  icon: `exclamation-triangle`,
                  title: t(`sandbox.discoverDetail.nightlyFailed`),
                  detail: problem,
              },
          ];
};

// The commit a listing installs, which no force-push upstream can change; absent for a listing with no pinned commit.
const pinnedCheck = (listing: DiscoverListing): TrustCheck[] => {
    const ref = listing.entry.install?.ref;
    return ref === undefined
        ? []
        : [
              {
                  id: `pinned`,
                  passed: true,
                  counted: true,
                  icon: `pin`,
                  title: t(`sandbox.discoverDetail.pinnedTo`, { ref: ref.slice(0, 7) }),
                  detail: t(`sandbox.discoverDetail.forcePushUpstreamCannot`),
              },
          ];
};

export const trustChecksOf = (listing: DiscoverListing): TrustCheck[] => [
    ...auditChecks(listing),
    listing.entry.trust === `verified`
        ? {
              id: `human`,
              passed: true,
              counted: true,
              icon: `user`,
              title: t(`sandbox.discoverDetail.humanReviewed`),
              detail: listing.entry.trustReason,
          }
        : { id: `human`, passed: false, counted: true, icon: `user`, title: t(`sandbox.discoverDetail.noHumanSourceReview`) },
    ...pinnedCheck(listing),
    ...loadCheck(listing),
    {
        id: `isolation`,
        passed: false,
        counted: false,
        icon: `window-maximize`,
        title: t(`sandbox.discoverDetail.notBrowserIsolated`),
        detail: t(`sandbox.discoverDetail.sharesPage`),
        why: t(`sandbox.discoverDetail.isolationWhy`),
    },
];

export interface TrustScore {
    readonly passed: number;
    readonly total: number;
}

/** How many of the counted guarantees hold, for the page's meter. */
export const trustScoreOf = (checks: readonly TrustCheck[]): TrustScore => {
    const counted = checks.filter((check) => check.counted);
    return { passed: counted.filter((check) => check.passed).length, total: counted.length };
};
