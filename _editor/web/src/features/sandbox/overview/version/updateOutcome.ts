import type { Info, UpdateOutcome } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { formatUntil } from "@intentic/ui/time";

// WHAT THE UPDATE CARD SAYS ABOUT THIS SANDBOX'S VERSION BEYOND "an update is out": what the machine last did about it
// (`lastUpdate`, written by the host's `ic`), a release taken back after it shipped (`withdrawn`), and a release the
// owner chose to skip (`skippedVersion`). Pure, so every sentence and every rule for which action applies is checked
// without mounting the card (updateOutcome.test.ts).

// An update that simply worked stops being news once its previous version is no longer kept ready; one the machine
// gave up on stays news for a week, and for as long as the version it gave up on is still the one on offer.
const FAILURE_NEWS_MS = 7 * 24 * 60 * 60_000;
const UPDATE_NEWS_MS = 24 * 60 * 60_000;

// `from`/`to` are versions, or the image when it would not say; a digest is noise in a sentence, so it is cut down to
// what a person could match against a listing.
export const versionName = (value: string): string => {
    if (/^v?\d+(?:\.\d+)+/.test(value)) {
        return value;
    }
    const leaf = value.slice(value.lastIndexOf(`/`) + 1);
    const digest = /^(.*@sha256:)([0-9a-f]{12})[0-9a-f]*$/.exec(leaf);
    return digest === null ? leaf : `${digest[1]}${digest[2]}`;
};

export interface OutcomeNews {
    /** What happened, as the card's own sentence. */
    readonly text: string;
    /** The host's plain words for why it gave up on a version; absent when nothing went wrong. */
    readonly reason: string | undefined;
    /** Where the host kept the swap's log: a path on the machine that runs the sandbox. */
    readonly log: string | undefined;
    readonly tone: `info` | `warning`;
    /** The version that was tried and given up on, which Try again and Skip act on. */
    readonly failed: string | undefined;
    /** The previous version is parked and ready right now: going back takes seconds. */
    readonly probation: boolean;
}

// "Updated from 1.315.0 to 1.316.0.", in the verb's own words. Undefined for a swap that moved no version (a reshape,
// a rebuild onto the same release): the machine did something, but nothing a version card has to explain.
const movedSentence = (outcome: UpdateOutcome): string | undefined => {
    const from = outcome.from === undefined ? undefined : versionName(outcome.from);
    const to = outcome.to === undefined ? undefined : versionName(outcome.to);
    if (outcome.verb === `rollback`) {
        return from !== undefined && to !== undefined
            ? t(`sandbox.updateOutcome.wentBackFromTo`, { from, to })
            : t(`sandbox.updateOutcome.wentBack`);
    }
    if (from !== undefined && to !== undefined && from !== to) {
        return t(`sandbox.updateOutcome.updatedFromTo`, { from, to });
    }
    return outcome.verb === `update` ? t(`sandbox.updateOutcome.updated`) : undefined;
};

const updatedNews = (outcome: UpdateOutcome, now: number): OutcomeNews | undefined => {
    const moved = movedSentence(outcome);
    const probation = outcome.keepUntil !== undefined && outcome.keepUntil > now;
    if (moved === undefined || (!probation && now - outcome.at > UPDATE_NEWS_MS)) {
        return undefined;
    }
    const ready = probation && outcome.keepUntil !== undefined ? t(`sandbox.updateOutcome.previousReadyUntil`, { when: formatUntil(outcome.keepUntil, now) }) : undefined;
    return {
        text: ready === undefined ? moved : `${moved} ${ready}`,
        reason: undefined,
        log: undefined,
        tone: `info`,
        failed: undefined,
        probation,
    };
};

// The new version never came up, so the host put the previous container straight back.
const restoredSentence = (outcome: UpdateOutcome): string => {
    const to = outcome.to === undefined ? undefined : versionName(outcome.to);
    if (to === undefined) {
        return t(`sandbox.updateOutcome.newDidntStart`);
    }
    return outcome.verb === undefined || outcome.verb === `update`
        ? t(`sandbox.updateOutcome.updateDidntStart`, { to })
        : t(`sandbox.updateOutcome.versionDidntStart`, { to });
};

// The new version came up and then failed its probation, and the host went back on its own.
const rolledBackSentence = (outcome: UpdateOutcome): string => {
    const from = outcome.from === undefined ? undefined : versionName(outcome.from);
    const to = outcome.to === undefined ? undefined : versionName(outcome.to);
    if (to !== undefined && from !== undefined) {
        return t(`sandbox.updateOutcome.keptFailingWentBackTo`, { to, from });
    }
    return to === undefined ? t(`sandbox.updateOutcome.newKeptFailing`) : t(`sandbox.updateOutcome.keptFailingWentBack`, { to });
};

/**
 * What the machine last did about this sandbox's version, as the card says it, or undefined when it is not news: no
 * record, a probation that ended quietly (`kept`), or an update that worked more than a day ago.
 */
export const outcomeNews = (outcome: UpdateOutcome | undefined, latest: string | undefined, now: number): OutcomeNews | undefined => {
    if (outcome === undefined || outcome.result === `kept`) {
        return undefined;
    }
    if (outcome.result === `updated`) {
        return updatedNews(outcome, now);
    }
    const stillOffered = outcome.to !== undefined && outcome.to === latest;
    if (!stillOffered && now - outcome.at > FAILURE_NEWS_MS) {
        return undefined;
    }
    return {
        text: outcome.result === `restored` ? restoredSentence(outcome) : rolledBackSentence(outcome),
        reason: outcome.reason,
        log: outcome.log,
        tone: `warning`,
        failed: outcome.to,
        probation: false,
    };
};

/** "Version 1.316.0 was withdrawn: <why>." */
export const withdrawnSentence = (withdrawn: NonNullable<Info[`withdrawn`]>): string =>
    withdrawn.reason === undefined || withdrawn.reason.trim() === ``
        ? t(`sandbox.updateOutcome.withdrawn`, { version: withdrawn.version })
        : t(`sandbox.updateOutcome.withdrawnBecause`, { version: withdrawn.version, reason: withdrawn.reason.trim() });

/** What the card knows beyond `/info`: where the sandbox runs and what this page can do about its version. */
export interface UpdateCardFacts {
    readonly info: Info | undefined;
    /** A hosted sandbox: the platform changes its image, and `lastUpdate` never comes from a host. */
    readonly hosted: boolean;
    /** Self-hosted: there is an image to go back to. Hosted: the platform kept the one before (`canRollBack`). */
    readonly canRollBack: boolean;
    /** The daemon serves `system.skipUpdate`; an older one would refuse the press. */
    readonly skipServed: boolean;
    readonly now: number;
}

export interface UpdateCardPlan {
    readonly news: OutcomeNews | undefined;
    readonly withdrawn: string | undefined;
    /** The release the owner skipped, while it is the newest and so the reason nothing is offered. */
    readonly skipped: string | undefined;
    /** The version a press on "Skip this version" skips; set only while it is the update on offer. */
    readonly skippable: string | undefined;
    /** The update on offer is the very version the machine gave up on, so the update button reads Try again. */
    readonly retry: boolean;
    /** Why going back is said out loud rather than left as the card's quiet link, or undefined for the quiet link. */
    readonly rollbackWhy: `withdrawn` | `probation` | undefined;
    /** Whether the card draws at all. */
    readonly visible: boolean;
}

// A skip only explains the card while it is what holds the newest release back; a newer one is offered regardless.
const skippedOf = (info: Info | undefined): string | undefined => {
    const skipped = info?.skippedVersion;
    return skipped !== undefined && skipped === info?.latest && info.updateAvailable !== true ? skipped : undefined;
};

// Going back is said out loud only when there is a reason to: the running release was withdrawn, or an update just
// happened and the version before it is still parked and ready.
const rollbackWhyOf = (canRollBack: boolean, withdrawn: boolean, news: OutcomeNews | undefined): UpdateCardPlan[`rollbackWhy`] => {
    if (!canRollBack) {
        return undefined;
    }
    if (withdrawn) {
        return `withdrawn`;
    }
    return news?.probation === true ? `probation` : undefined;
};

// One place for "which of the card's actions apply", so the template only draws what this says.
export const updateCardPlan = ({ info, hosted, canRollBack, skipServed, now }: UpdateCardFacts): UpdateCardPlan => {
    const latest = info?.latest;
    const offered = info?.updateAvailable === true;
    const news = hosted ? undefined : outcomeNews(info?.lastUpdate, latest, now);
    const withdrawn = info?.withdrawn === undefined ? undefined : withdrawnSentence(info.withdrawn);
    const skipped = skipServed ? skippedOf(info) : undefined;
    const retry = offered && news?.failed !== undefined && news.failed === latest;
    const said = [news, withdrawn, skipped].some((part) => part !== undefined);
    return {
        news,
        withdrawn,
        skipped,
        skippable: skipServed && retry ? latest : undefined,
        retry,
        rollbackWhy: rollbackWhyOf(canRollBack, withdrawn !== undefined, news),
        visible: offered || canRollBack || said,
    };
};
