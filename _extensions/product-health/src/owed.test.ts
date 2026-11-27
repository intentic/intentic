import { attentionOf, owedOf } from "./owed";
import type { Finding, FindingAgent } from "./wire";

const NOW = 1_000_000;
const finding = (overrides: Partial<Finding> = {}): Finding => ({
    id: `c:error:e`,
    connection: `c`,
    source: `error`,
    sourceId: `e`,
    kind: `web`,
    lane: `fix`,
    severity: `warning`,
    title: `TypeError`,
    summary: ``,
    link: `https://us.posthog.com/project/1/error_tracking/e`,
    code: [],
    untrusted: {},
    actions: [`fix`],
    ...overrides,
});
const agent = (stance: FindingAgent[`stance`], ownerStep?: string): FindingAgent => ({ conversationId: `health-x`, attempt: 1, stance, label: stance, hint: ``, ownerStep });

describe(`what a finding owes the reader`, () => {
    test(`a fix nobody is on, or whose agent gave up, is owed; an agent at work or waiting on its allowance needs nobody`, () => {
        expect(owedOf(finding(), NOW)).toBe(`unowned`);
        expect(owedOf(finding({ agent: agent(`ended`) }), NOW)).toBe(`handed-back`);
        expect(owedOf(finding({ agent: agent(`working`) }), NOW)).toBeUndefined();
        expect(owedOf(finding({ agent: agent(`waiting`) }), NOW)).toBeUndefined();
    });

    test(`an agent waiting on the reader is owed by what it waits for`, () => {
        expect(owedOf(finding({ agent: agent(`needs-you`) }), NOW)).toBe(`answer`);
        expect(owedOf(finding({ agent: agent(`ready`) }), NOW)).toBe(`review`);
        expect(owedOf(finding({ agent: agent(`landed`) }), NOW)).toBe(`landed`);
    });

    test(`a step is the owner's whether PostHog or the agent said so`, () => {
        expect(owedOf(finding({ lane: `step` }), NOW)).toBe(`step`);
        expect(owedOf(finding({ agent: agent(`ended`, `Add the URL in PostHog's settings.`) }), NOW)).toBe(`step`);
    });

    test(`decisions, setup advice and quiet alerts are shown, never owed; a snoozed finding owes nothing until it wakes`, () => {
        expect(owedOf(finding({ lane: `decide` }), NOW)).toBeUndefined();
        expect(owedOf(finding({ lane: `setup` }), NOW)).toBeUndefined();
        expect(owedOf(finding({ lane: `watch` }), NOW)).toBeUndefined();
        expect(owedOf(finding({ snoozedUntil: NOW + 1 }), NOW)).toBeUndefined();
        expect(owedOf(finding({ snoozedUntil: NOW - 1 }), NOW)).toBe(`unowned`);
    });
});

describe(`the badge`, () => {
    test(`danger only for something critical nobody is on; the rest of what is owed is a warning or the resting tone`, () => {
        // The owner's project on 2026-11-26: a critical outdated SDK, two warnings to fix, one setting to change.
        const today = [
            finding({ source: `health`, severity: `critical` }),
            finding({ source: `health` }),
            finding({ source: `health` }),
            finding({ source: `health`, lane: `step` }),
            finding({ source: `alert`, lane: `watch`, severity: `info` }),
        ];
        expect(attentionOf(today, NOW)).toEqual({ owed: 4, handled: 0, tone: `danger` });
        expect(attentionOf([finding({ severity: `critical`, agent: agent(`working`) }), finding({ severity: `info` })], NOW)).toEqual({ owed: 1, handled: 1, tone: `info` });
        expect(attentionOf([finding({ severity: `info`, lane: `step` })], NOW).tone).toBe(`warning`);
        expect(attentionOf([], NOW)).toEqual({ owed: 0, handled: 0, tone: `info` });
    });
});
