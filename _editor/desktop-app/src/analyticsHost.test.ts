import { describe, expect, it } from "bun:test";
import { captureUrl } from "./analyticsHost";

describe(`desktop PostHog capture host`, () => {
    it(`uses the configured region and normalizes a trailing slash`, () => {
        expect(captureUrl(`https://eu.i.posthog.com/`)).toBe(`https://eu.i.posthog.com/i/v0/e/`);
        expect(captureUrl(`https://us.i.posthog.com`)).toBe(`https://us.i.posthog.com/i/v0/e/`);
    });
});
