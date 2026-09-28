// What the update card says about this sandbox's version beyond "an update is out", and which of its actions apply.
// Instants are built on the runner's own calendar (`new Date(y, m, d, h, min)`), since "until 14:05 tomorrow" is read
// off the reader's clock and a UTC-built instant would move the day with the machine the suite runs on.
import type { Info, UpdateOutcome } from "@intentic/sandbox-contract";
import { outcomeNews, updateCardPlan, versionName, withdrawnSentence } from "./updateOutcome";

const NOW = new Date(2026, 8, 28, 16, 30).getTime();
const HOUR = 60 * 60_000;
const TOMORROW_1405 = new Date(2026, 8, 29, 14, 5).getTime();

const outcome = (over: Partial<UpdateOutcome> & Pick<UpdateOutcome, `result`>): UpdateOutcome => ({
    verb: `update`,
    at: NOW - HOUR,
    from: `1.315.0`,
    to: `1.316.0`,
    ...over,
});

const info = (over: Partial<Info> = {}): Info => ({ version: `1.315.0`, latest: `1.316.0`, updateAvailable: true, ...over });

describe(`what the machine last did, in plain words`, () => {
    it(`says an update took, keeping until when the version before it stays ready out of the headline`, () => {
        expect(outcomeNews(outcome({ result: `updated`, keepUntil: TOMORROW_1405 }), `1.316.0`, NOW)).toEqual({
            text: `Updated from 1.315.0 to 1.316.0.`,
            reason: undefined,
            log: undefined,
            tone: `info`,
            failed: undefined,
            probation: true,
            ready: `That version stays ready on this machine until 14:05 tomorrow, so going back takes seconds.`,
        });
    });

    it(`drops the ready line once the previous version is gone, and the whole line a day after the update`, () => {
        const ended = outcome({ result: `updated`, keepUntil: NOW - 1 });
        expect(outcomeNews(ended, `1.316.0`, NOW)).toMatchObject({ text: `Updated from 1.315.0 to 1.316.0.`, probation: false, ready: undefined });
        expect(outcomeNews({ ...ended, at: NOW - 25 * HOUR }, `1.316.0`, NOW)).toBeUndefined();
        // A probation that ended quietly is the host's own "nothing to report".
        expect(outcomeNews(outcome({ result: `kept` }), `1.316.0`, NOW)).toBeUndefined();
    });

    it(`says an update that never started was put back, with the host's reason and log`, () => {
        const news = outcomeNews(
            outcome({ result: `restored`, reason: `It never answered its health check.`, log: `~/.intentic/logs/update-work.log` }),
            `1.316.0`,
            NOW,
        );
        expect(news).toEqual({
            text: `The update to 1.316.0 didn't start, so the previous version was put back.`,
            reason: `It never answered its health check.`,
            log: `~/.intentic/logs/update-work.log`,
            tone: `warning`,
            failed: `1.316.0`,
            probation: false,
            ready: undefined,
        });
    });

    it(`says a version that kept failing was left by the machine itself, naming what it went back to`, () => {
        expect(outcomeNews(outcome({ result: `rolled-back`, verb: `probation` }), `1.316.0`, NOW)?.text).toBe(
            `1.316.0 kept failing, so this machine went back to 1.315.0 by itself.`,
        );
        expect(outcomeNews(outcome({ result: `rolled-back`, from: undefined }), `1.316.0`, NOW)?.text).toBe(
            `1.316.0 kept failing, so this machine went back to the previous version by itself.`,
        );
        expect(outcomeNews(outcome({ result: `rolled-back`, from: undefined, to: undefined }), `1.316.0`, NOW)?.text).toBe(
            `The new version kept failing, so this machine went back to the previous one by itself.`,
        );
    });

    it(`keeps a failure on the card for a week, and past it while that version is still the one on offer`, () => {
        const old = outcome({ result: `restored`, at: NOW - 8 * 24 * HOUR });
        expect(outcomeNews(old, `1.317.0`, NOW)).toBeUndefined();
        expect(outcomeNews(old, `1.316.0`, NOW)?.failed).toBe(`1.316.0`);
    });

    it(`says a rollback the owner asked for as going back, and nothing for a swap that moved no version`, () => {
        expect(outcomeNews(outcome({ result: `updated`, verb: `rollback`, from: `1.316.0`, to: `1.315.0` }), `1.316.0`, NOW)?.text).toBe(
            `Went back from 1.316.0 to 1.315.0.`,
        );
        expect(outcomeNews(outcome({ result: `updated`, verb: `reshape`, from: `1.316.0`, to: `1.316.0` }), `1.316.0`, NOW)).toBeUndefined();
    });

    it(`names an image by what a listing would show rather than its whole digest`, () => {
        expect(versionName(`ghcr.io/intentic/sandbox@sha256:0123456789abcdef0123456789abcdef`)).toBe(`sandbox@sha256:0123456789ab`);
        expect(versionName(`1.316.0`)).toBe(`1.316.0`);
        expect(versionName(`intentic-sandbox:rollback-work`)).toBe(`intentic-sandbox:rollback-work`);
    });

    it(`says a withdrawn release in the words of the people who withdrew it`, () => {
        expect(withdrawnSentence({ version: `1.316.0`, reason: `It loses chat history on Windows.` })).toBe(
            `Version 1.316.0 was withdrawn: It loses chat history on Windows.`,
        );
        expect(withdrawnSentence({ version: `1.316.0` })).toBe(`Version 1.316.0 was withdrawn.`);
    });
});

describe(`which of the card's actions apply`, () => {
    const base = { hosted: false, canRollBack: true, skipServed: true, now: NOW };

    it(`turns Update into Try again, with Skip beside it, when the version on offer is the one that failed`, () => {
        const plan = updateCardPlan({ ...base, info: info({ lastUpdate: outcome({ result: `rolled-back` }) }) });
        expect(plan).toMatchObject({ retry: true, skippable: `1.316.0`, rollbackWhy: undefined, visible: true });
        // An older daemon would refuse the skip, so it is not offered; the retry still is.
        expect(updateCardPlan({ ...base, skipServed: false, info: info({ lastUpdate: outcome({ result: `rolled-back` }) }) })).toMatchObject({
            retry: true,
            skippable: undefined,
        });
        // A newer release than the one that failed is a plain update.
        expect(updateCardPlan({ ...base, info: info({ latest: `1.317.0`, lastUpdate: outcome({ result: `rolled-back` }) }) })).toMatchObject({
            retry: false,
            skippable: undefined,
        });
    });

    it(`says a skip only while it is what holds the newest release back`, () => {
        expect(updateCardPlan({ ...base, info: info({ updateAvailable: false, skippedVersion: `1.316.0` }) }).skipped).toBe(`1.316.0`);
        expect(updateCardPlan({ ...base, info: info({ updateAvailable: true, latest: `1.317.0`, skippedVersion: `1.316.0` }) }).skipped).toBeUndefined();
    });

    it(`puts going back up front only for a withdrawn release, never beside an update that worked`, () => {
        const probation = outcome({ result: `updated`, keepUntil: TOMORROW_1405 });
        expect(updateCardPlan({ ...base, info: info({ updateAvailable: false, lastUpdate: probation }) }).rollbackWhy).toBeUndefined();
        expect(
            updateCardPlan({ ...base, info: info({ updateAvailable: false, lastUpdate: probation, withdrawn: { version: `1.316.0` } }) }).rollbackWhy,
        ).toBe(`withdrawn`);
        expect(updateCardPlan({ ...base, canRollBack: false, info: info({ withdrawn: { version: `1.316.0` } }) })).toMatchObject({
            rollbackWhy: undefined,
            withdrawn: `Version 1.316.0 was withdrawn.`,
        });
    });

    it(`draws for a hosted sandbox the platform can take back, and never reads a host's record for one`, () => {
        const quiet = info({ updateAvailable: false, latest: `1.315.0` });
        expect(updateCardPlan({ ...base, canRollBack: false, info: quiet }).visible).toBe(false);
        expect(updateCardPlan({ ...base, hosted: true, canRollBack: true, info: quiet }).visible).toBe(true);
        expect(updateCardPlan({ ...base, hosted: true, info: info({ lastUpdate: outcome({ result: `rolled-back` }) }) }).news).toBeUndefined();
    });
});
