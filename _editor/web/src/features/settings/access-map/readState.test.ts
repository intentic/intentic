import type { SandboxSummary } from "@intentic/api-contract";
import type { SandboxReach } from "@intentic/sandbox-contract/schemas/sandbox-reach";
import { SandboxTimeoutError } from "../../../client/sandbox/sandboxAuthFetch";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { failureOf, readStateOf } from "./readState";

// How the access map says one sandbox's read stands: a sandbox that cannot be asked now (asleep, down, no address) is never
// asked and keeps its last answer, and a read that failed says which of the reader's next moves it calls for.

const row = (extra: Partial<SandboxSummary> = {}): SandboxSummary =>
    ({
        id: `s1`,
        name: `s1`,
        image: null,
        daemonUrl: `https://sandbox-s1.sbx.intentic.dev`,
        lastSeenAt: null,
        setupCodeClaimedAt: null,
        setupReport: null,
        bootReport: null,
        announceRefusal: null,
        removedAt: null,
        removedBy: null,
        token: null,
        tier: `owner`,
        providedAddress: true,
        localHostname: null,
        hosted: null,
        ...extra,
    }) satisfies SandboxSummary;

const ANSWER: SandboxReach = { self: {}, reader: { tier: `owner`, agents: true }, linksOut: [], devices: [], servers: [], readAt: 1 };
const idle = { fetching: false, error: null, answer: ANSWER };

describe(`readStateOf`, () => {
    test(`a sandbox asleep on its machine, or a hosted one asleep or starting, is asleep and never read`, () => {
        expect(readStateOf(row({ sleep: { heardAt: `2026-11-22T00:00:00.000Z`, wakeable: true } }), idle)).toBe(`asleep`);
        expect(readStateOf(row({ hosted: { state: `asleep`, region: `fra`, warm: true } }), idle)).toBe(`asleep`);
        expect(readStateOf(row({ hosted: { state: `starting`, region: `fra`, warm: true } }), idle)).toBe(`asleep`);
    });

    test(`one with no address, or a hosted one that is down, does not answer`, () => {
        expect(readStateOf(row({ daemonUrl: null }), idle)).toBe(`unreachable`);
        expect(readStateOf(row({ hosted: { state: `down`, region: `fra`, warm: true } }), idle)).toBe(`unreachable`);
    });

    test(`an answer is fresh; one being asked again is reading, whatever it said last`, () => {
        expect(readStateOf(row(), idle)).toBe(`fresh`);
        expect(readStateOf(row(), { ...idle, fetching: true })).toBe(`reading`);
        expect(readStateOf(row(), { fetching: false, error: null, answer: undefined })).toBe(`reading`);
    });

    test(`a failure wins over the answer kept from before`, () => {
        expect(readStateOf(row(), { ...idle, error: new SandboxHttpError(404, `not found`) })).toBe(`old`);
    });
});

describe(`failureOf`, () => {
    test(`names the reader's next move by what the daemon answered`, () => {
        expect(failureOf(new SandboxHttpError(404, `not found`))).toBe(`old`);
        expect(failureOf(new SandboxHttpError(403, `refused`))).toBe(`locked`);
        expect(failureOf(new SandboxHttpError(401, `who`))).toBe(`signin`);
        expect(failureOf(new SandboxHttpError(502, `bad gateway`))).toBe(`unreachable`);
    });

    test(`no answer at all is unreachable; no session to read under is a sign-in`, () => {
        expect(failureOf(new SandboxTimeoutError())).toBe(`unreachable`);
        expect(failureOf(new TypeError(`Failed to fetch`))).toBe(`unreachable`);
        expect(failureOf(new Error(`no session could be had without asking`))).toBe(`signin`);
    });
});
