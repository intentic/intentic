import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";

// targetFor must never present one sandbox's credentials to another sandbox's daemon; sandboxAuthFetch's
// belongsTo check is a backstop, but this is where the address itself must be right.

const active = ref<{ token?: string } | undefined>({ token: `connect-here` });
const activeSandboxId = ref<string | undefined>(`sbx-here`);
const daemonUrl = ref<string | undefined>(`https://here.test`);
const sandboxes = ref<{ id: string; daemonUrl: string | null; token: string }[]>([]);
vi.mock("./useSandbox", () => ({ useSandbox: () => ({ active, activeSandboxId, daemonUrl, sandboxes }) }));

// The real useEndpoint runs on this mock: with no loopback resolved, daemonBase falls to daemonUrl.
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

    // The loopback probe costs real time and a Chrome permission prompt per candidate; paying that for boxes nobody
    // asked about is what this refuses.
    it("never reaches for a loopback shortcut on a box the app is not pointed at", () => {
        expect(targetFor(`sbx-laptop`)?.base).toBe(`https://laptop.test`);
    });

    // Otherwise naming the active sandbox by id would quietly opt it out of its own resolved shortcut.
    it("delegates to the ordinary target when the id names the active sandbox", () => {
        expect(targetFor(`sbx-here`)).toEqual(currentSandboxTarget());
    });

    // Undefined, not a guessed empty string, so the caller reports "not answering" instead of dialing nothing.
    it("has no target for a sandbox with no address", () => {
        expect(targetFor(`sbx-never`)).toBeUndefined();
    });

    it("has no target for an id the account does not hold", () => {
        expect(targetFor(`sbx-stranger`)).toBeUndefined();
    });
});
