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

    // A 22, a 530 or a 1033 is only what it says where an address, a status or an error code holds it.
    it(`reads a port or a status only where the error names one`, () => {
        expect(describeProvisionError(`ssh: connect to host deploy.example port 22: Connection refused`)).toContain(`SSH`);
        expect(describeProvisionError(`dial tcp [2001:db8::1]:22: connect: no route to host`)).toContain(`SSH`);
        expect(describeProvisionError(`Request failed with status code 530`)).toContain(`Forgejo`);
        expect(describeProvisionError(`HTTP/1.1 530`)).toContain(`Forgejo`);
        expect(describeProvisionError(`Error 1033: Argo Tunnel error`)).toContain(`Forgejo`);
        for (const raw of [`plan failed at 10:22 on step 3`, `TypeError at src/plan.ts:22`, `copied 530 files`, `1033 resources planned`]) {
            expect(describeProvisionError(raw)).toBe(raw);
        }
    });

    it(`passes an unrecognized error through unchanged`, () => {
        expect(describeProvisionError(`something else entirely`)).toBe(`something else entirely`);
    });
});
