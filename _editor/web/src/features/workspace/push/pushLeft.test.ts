import type { Finding, PushCheck, PushChecks, Red } from "@intentic/sandbox-contract";
import { leftSince } from "./pushLeft";

// No mocks: what a push left is a pure reading of the record the daemon serves (GET /workspace/push-checks).
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const finding = (id: string): Finding => ({ id, source: id, recheckable: true, text: `${id} says so` });

const push = (id: string, at: number, findings: Finding[], project = `intentic`): PushCheck => ({
    project,
    id,
    at,
    branch: `main`,
    head: `${id}0000000000`,
    commits: 1,
    findings,
});

// A project's push red as the daemon files it: everything its pushes found, less what was since resolved or dismissed.
const owing = (scope: string, owed: readonly string[]): Red => ({
    source: `push`,
    scope,
    since: NOW - 30 * MINUTE,
    findings: owed.map(finding),
    decisions: [],
});

describe(`leftSince`, () => {
    it(`counts what the pushes measured from the moment on left owed, and nothing from before it`, () => {
        // The newest push brought two, of which `lint` has since been settled; web's push brought two of its own.
        const record: PushChecks = {
            pushed: [
                push(`b`, NOW, [finding(`paths`), finding(`lint`)]),
                push(`w`, NOW - 1, [finding(`layout`), finding(`buttons`)], `web`),
                push(`a`, NOW - MINUTE, [finding(`silent-catch`)]),
            ],
            reds: [owing(`intentic`, [`silent-catch`, `paths`]), owing(`web`, [`layout`, `buttons`])],
        };
        expect([leftSince(record, NOW - 1), leftSince(record, NOW), leftSince(record, NOW + 1), leftSince(undefined, 0)]).toEqual([3, 1, 0, 0]);
    });

    it(`counts nothing for a push whose project owes nothing any more`, () => {
        expect(leftSince({ pushed: [push(`b`, NOW, [finding(`paths`)])], reds: [] }, NOW)).toBe(0);
    });
});
