import { resetSandboxScope, sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { beforeEach, describe, expect, it } from "vitest";

/* The extensions' state scope (extension-api/src/scope.ts), tested from here because the SDK ships no test
 * harness of its own — the same reason surface-guard.test.ts and permissions.conformance.test.ts live in this
 * directory rather than beside the package they hold to account.
 *
 * The rule under test is the one the reported bug broke: a rail badge filled from module state kept the
 * PREVIOUS sandbox's count after a switch, under the new sandbox's name. */

// Every registration is permanent by design (a module registers once, at import), so the suite shares one
// registry and simply resets between cases.
beforeEach(() => {
    resetSandboxScope();
});

describe(`sandboxRef`, () => {
    it(`goes back to its initial value when the scope closes`, () => {
        const unseen = sandboxRef<readonly string[]>(() => []);
        unseen.value = [`patch-advisories`, `update-deps`];

        resetSandboxScope();

        expect(unseen.value).toEqual([]);
    });

    it(`builds a FRESH initial value each time, so one scope cannot mutate the next one's starting point`, () => {
        const documents = sandboxRef(() => new Map<string, string>());
        const first = documents.value;
        first.set(`intentic/_sandbox/acp-bridge`, `the ACP bridge`);

        resetSandboxScope();

        expect(documents.value.size).toBe(0);
        expect(documents.value).not.toBe(first);
    });

    it(`hands the outgoing value to its disposer — the door for state that owns something the GC will not take`, () => {
        const revoked: string[] = [];
        const previews = sandboxRef<Record<string, string>>(
            () => ({}),
            (previous) => revoked.push(...Object.values(previous)),
        );
        previews.value = { "a.png": `blob:one`, "b.png": `blob:two` };

        resetSandboxScope();

        expect(revoked).toEqual([`blob:one`, `blob:two`]);
        expect(previews.value).toEqual({});
    });

    it(`clears every registered ref, which is the whole reason the registry is shared across extensions`, () => {
        const one = sandboxRef(() => 0);
        const two = sandboxRef(() => `idle`);
        one.value = 21;
        two.value = `busy`;

        resetSandboxScope();

        expect(one.value).toBe(0);
        expect(two.value).toBe(`idle`);
    });
});

describe(`sandboxScopeGuard`, () => {
    it(`answers true while the scope it was taken in is still open`, () => {
        const current = sandboxScopeGuard();

        expect(current()).toBe(true);
    });

    it(`answers false once the scope has closed — a poll's answer arriving after a switch`, () => {
        const current = sandboxScopeGuard();

        resetSandboxScope();

        expect(current()).toBe(false);
    });

    it(`stays false after a further switch, rather than coming back round`, () => {
        const current = sandboxScopeGuard();

        resetSandboxScope();
        resetSandboxScope();

        expect(current()).toBe(false);
    });

    it(`is what keeps an in-flight read out of the new scope`, async () => {
        const unseen = sandboxRef<readonly string[]>(() => []);

        // A poll that left under the old sandbox and lands under the new one.
        const poll = async (): Promise<void> => {
            const current = sandboxScopeGuard();
            const answer = await Promise.resolve([`a chore from the box we just left`]);
            if (!current()) {
                return;
            }
            unseen.value = answer;
        };
        const inFlight = poll();
        resetSandboxScope();
        await inFlight;

        expect(unseen.value).toEqual([]);
    });
});
