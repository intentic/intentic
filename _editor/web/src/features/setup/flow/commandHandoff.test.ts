import type { SetupReport } from "@intentic/api-contract";
import { describe, expect, it } from "bun:test";
import {
    handoffOf,
    type HandoffInput,
    type LockInput,
    lockedReasonOf,
    nudgeAfterMs,
    type NudgeReader,
    nudgeVariantOf,
    SLOW_BUILD_MS,
    STALLED_MS,
    waitedFrom,
} from "./commandHandoff";

// Pins the command's journey as values (locked until ready, claimed on either proof, handed once copied or given to the
// app), the one missing answer a locked card names, and which reader a stuck wait's correction addresses and when.

const ready: HandoffInput = { commandReady: true, claimedAt: null, report: null, copied: false, launched: false };
const report: SetupReport = { stage: `preflight`, failed: [], at: `2026-09-23T10:00:00Z` };

describe(`the command's journey to a machine`, () => {
    it.each<[string, HandoffInput, ReturnType<typeof handoffOf>]>([
        [`locked with no command, whatever else is true`, { ...ready, commandReady: false, claimedAt: `2026-09-23T10:00:00Z` }, `locked`],
        [`the reader's while nothing has happened to it`, ready, `yours`],
        [`handed once copied`, { ...ready, copied: true }, `handed`],
        [`handed once given to the app`, { ...ready, launched: true }, `handed`],
        [`claimed once a machine redeemed the code`, { ...ready, copied: true, claimedAt: `2026-09-23T10:00:00Z` }, `claimed`],
        [`claimed by a report arriving before the redemption`, { ...ready, report }, `claimed`],
    ])(`is %s`, (_, input, handoff) => {
        expect(handoffOf(input)).toBe(handoff);
    });
});

const zone: LockInput = {
    addressless: false,
    mode: `own`,
    mintError: undefined,
    cfToken: `cf-token`,
    cfTokenValid: true,
    zonesLoading: false,
    zonesError: undefined,
    zone: `example.dev`,
    subdomainValid: true,
};

describe(`a locked command`, () => {
    it.each<[string, LockInput, string]>([
        [
            `states the platform's fact rather than a wait`,
            { ...zone, addressless: true, mode: `intentic` },
            `This platform doesn't hand out addresses, so there's no install command to run. Connect a sandbox you're already running instead.`,
        ],
        [`prepares the intentic domain`, { ...zone, mode: `intentic` }, `Preparing your intentic domain…`],
        [`names a failed mint on the intentic path`, { ...zone, mode: `intentic`, mintError: `Couldn't prepare it.` }, `Couldn't prepare it.`],
        [`asks for the token first`, { ...zone, cfToken: `` }, `Enter your Cloudflare API token to reveal your install command.`],
        [
            `waits on a token that does not look valid`,
            { ...zone, cfTokenValid: false },
            `Your install command appears once the token above looks valid.`,
        ],
        [`says the zones are being checked`, { ...zone, zonesLoading: true }, `Checking which Cloudflare zones this token can use…`],
        [`points at the token's problem`, { ...zone, zonesError: `No zones.` }, `Fix the Cloudflare token issue above to continue.`],
        [`asks for a zone`, { ...zone, zone: undefined }, `Choose which Cloudflare zone to use to reveal your command.`],
        [
            `asks for a valid subdomain`,
            { ...zone, subdomainValid: false },
            `Enter a valid subdomain (letters, numbers, hyphens) to reveal your command.`,
        ],
        [`names a failed mint once the form is complete`, { ...zone, mintError: `Couldn't prepare it.` }, `Couldn't prepare it.`],
        [`prepares the command once the form is complete`, zone, `Preparing your install command…`],
    ])(`%s`, (_, lock, reason) => {
        expect(lockedReasonOf(lock)).toBe(reason);
    });
});

const reader: NudgeReader = { mobile: false, emailed: false, commandVisible: false, installing: false, downloaded: false, launched: false };

describe(`a stuck wait's correction`, () => {
    it.each<[string, NudgeReader, ReturnType<typeof nudgeVariantOf>]>([
        [`a phone that mailed itself the link`, { ...reader, mobile: true, emailed: true, commandVisible: true }, `emailed`],
        [`a terminal wherever the command is on screen`, { ...reader, commandVisible: true, installing: true }, `terminal`],
        [`an installer not yet downloaded`, { ...reader, installing: true }, `install`],
        [`an installer the reader downloaded`, { ...reader, installing: true, downloaded: true }, `downloaded`],
        [`a phone with the command folded away`, { ...reader, mobile: true }, `phone`],
        [`the app it was handed to`, { ...reader, launched: true }, `app`],
        [`the app's button nobody pressed`, reader, `button`],
    ])(`addresses %s`, (_, input, variant) => {
        expect(nudgeVariantOf(input)).toBe(variant);
    });

    it(`waits three minutes where the command is not the path, forty seconds beside it`, () => {
        expect([nudgeAfterMs(true), nudgeAfterMs(false)]).toEqual([180_000, 40_000]);
        expect([STALLED_MS, SLOW_BUILD_MS]).toEqual([180_000, 360_000]);
    });

    it(`dates the wait from the later of the command and the reader's last act`, () => {
        expect(waitedFrom(5_000, 9_000)).toBe(9_000);
        expect(waitedFrom(9_000, 5_000)).toBe(9_000);
        expect(waitedFrom(5_000, undefined)).toBe(5_000);
        expect(waitedFrom(undefined, 9_000)).toBe(undefined);
    });
});
