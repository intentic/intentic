import { describe, expect, it } from "vitest";
import { describeProvisionError } from "./provisionError";

describe(`describeProvisionError`, () => {
    it(`names the unset secret`, () => {
        const message = describeProvisionError(`Error: missing secret env var "STRIPE_API_KEY"`);
        expect(message).toContain(`STRIPE_API_KEY`);
        expect(message).toContain(`isn't set yet`);
    });

    it(`explains an SSH-unreachable host`, () => {
        expect(describeProvisionError(`connect ECONNREFUSED 10.0.0.1:22`)).toContain(`couldn't reach the deploy host over SSH`);
        expect(describeProvisionError(`dial tcp :22: i/o timeout ETIMEDOUT`)).toContain(`SSH`);
    });

    it(`explains a not-yet-live Cloudflare tunnel`, () => {
        expect(describeProvisionError(`request failed with status 530`)).toContain(`Forgejo`);
        expect(describeProvisionError(`Cloudflare Tunnel error 1033`)).toContain(`tunnel`);
    });

    it(`passes an unrecognized error through unchanged`, () => {
        expect(describeProvisionError(`something else entirely`)).toBe(`something else entirely`);
    });
});
