import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

/* WHERE A CALL AIMED AT A NAMED SANDBOX GOES. The one lookup the cross-sandbox surfaces rest on, and the one
 * place a mistake would be expensive rather than merely wrong: everything below it, the bearer store and the
 * fetch policy, is already keyed by sandbox id, so a target that named the wrong base would present one box's
 * credentials to another box's daemon. `sandboxAuthFetch`'s `belongsTo` refuses that, which is what turns the
 * mistake into a failed request rather than a leak, but this is where it must not happen in the first place. */

const active = ref<{ token?: string } | undefined>({ token: `connect-here` });
const activeSandboxId = ref<string | undefined>(`sbx-here`);
const daemonUrl = ref<string | undefined>(`https://here.test`);
const sandboxes = ref<{ id: string; daemonUrl: string | null; token: string }[]>([]);
vi.mock("./useSandbox", () => ({ useSandbox: () => ({ active, activeSandboxId, daemonUrl, sandboxes }) }));

// The real useEndpoint rides on the mock above: with no loopback shortcut resolved, its daemonBase falls
// through to daemonUrl, which is what makes the active-sandbox delegation observable here.
const { currentSandboxTarget, targetFor } = await import("./sandboxTarget");

beforeEach(() => {
    sandboxes.value = [
        { id: `sbx-here`, daemonUrl: `https://here.test`, token: `connect-here` },
        { id: `sbx-laptop`, daemonUrl: `https://laptop.test`, token: `connect-laptop` },
        { id: `sbx-never`, daemonUrl: null, token: `connect-never` },
    ];
});

describe("targetFor", () => {
    it("addresses another sandbox at its own public URL, with its own connect token", () => {
        expect(targetFor(`sbx-laptop`)).toEqual({ sandboxId: `sbx-laptop`, base: `https://laptop.test`, connectToken: `connect-laptop` });
    });

    /* THE TUNNEL, ALWAYS, for a box this browser is not pointed at. The loopback shortcut is qualified by a
     * probe costing up to 1500 ms per candidate and, the first time, a Chrome Local Network Access prompt
     * (endpoint.ts). Spending that on four machines nobody asked to talk to is the cost this rule exists to
     * refuse, so the base here is the registry's address and never a resolved one. */
    it("never reaches for a loopback shortcut on a box the app is not pointed at", () => {
        expect(targetFor(`sbx-laptop`)?.base).toBe(`https://laptop.test`);
    });

    // Aimed at the box already selected, it IS the ordinary target: the resolved endpoint, the stream's socket
    // pool, everything that box has earned. A parallel answer here would quietly opt the active sandbox out of
    // its own shortcut whenever a caller happened to name it by id.
    it("delegates to the ordinary target when the id names the active sandbox", () => {
        expect(targetFor(`sbx-here`)).toEqual(currentSandboxTarget());
    });

    // A sandbox that has never announced an address is not somewhere a call can go. Undefined rather than a
    // guess, so the caller reports "not answering" instead of dialling an empty string.
    it("has no target for a sandbox with no address", () => {
        expect(targetFor(`sbx-never`)).toBeUndefined();
    });

    it("has no target for an id the account does not hold", () => {
        expect(targetFor(`sbx-stranger`)).toBeUndefined();
    });
});
