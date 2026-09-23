import "@intentic/testing/dom";
import type { SandboxSummary, SetupCode } from "@intentic/api-contract";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { type EffectScope, effectScope, nextTick, ref } from "vue";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import type { Machine } from "./machineLadder";
import { type CommandLaneHost, useCommandLane } from "./useCommandLane";

// Pins the own-computer lane's code: minted after half a second of quiet for the row and lane on screen, never for
// attach, a hosted rung or a platform without addresses; a stale answer dropped, a fresh code restarting the handoff,
// a missing route read as a platform with no addresses, and any other failure left for the reader's retry.

const code = (sandboxId: string): SetupCode => ({
    code: `code-${sandboxId}`,
    hostname: `sandbox-${sandboxId}.sbx.intentic.dev`,
    expiresAt: `2026-09-23T10:10:00Z`,
});

const scopes: EffectScope[] = [];

const stage = () => {
    const setupCode = mock(async ({ sandboxId }: { sandboxId: string }) => code(sandboxId));
    const row = { created: ref<SandboxSummary | null>(null), claimedAt: ref<string | null>(null) };
    const hosted = { machine: ref<Machine>(`mine`), hostedRow: ref<SandboxSummary[`hosted`]>(null), releasingHosted: ref(false) };
    const lane = ref<`provision` | `attach`>(`provision`);
    const scope = effectScope();
    scopes.push(scope);
    const command = scope.run(() =>
        useCommandLane({ platform: unstubbed<CommandLaneHost[`platform`]>(`platform`, { setupCode }), row, hosted, lane }),
    )!;
    command.recordOffer({ kind: `answered`, value: { enabled: true } });
    return { setupCode, row, hosted, lane, scope, command };
};

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    jest.useRealTimers();
});

describe(`minting the code`, () => {
    it(`mints once the row has been settled for half a second, and only for the row still on screen`, async () => {
        const { setupCode, row, command } = stage();
        row.created.value = sandboxSummary({ id: `a`, token: `tok-a` });
        await nextTick();
        await advanceTimersByTimeAsync(300);
        row.created.value = sandboxSummary({ id: `b`, token: `tok-b` });
        await nextTick();
        await advanceTimersByTimeAsync(499);
        expect(setupCode).not.toHaveBeenCalled();
        await advanceTimersByTimeAsync(1);
        expect(setupCode.mock.calls).toEqual([[{ sandboxId: `b` }]]);
        expect(command.setup.value).toEqual(code(`b`));
        expect(command.commandReady.value).toBe(true);
    });

    it.each<[string, (staged: ReturnType<typeof stage>) => void]>([
        [`the attach lane`, ({ lane }) => (lane.value = `attach`)],
        [`the hosted rung`, ({ hosted }) => (hosted.machine.value = `hosted`)],
        [`a row carrying a machine`, ({ hosted }) => (hosted.hostedRow.value = { region: `iad`, warm: true })],
        [`a machine being handed back`, ({ hosted }) => (hosted.releasingHosted.value = true)],
        [`a platform with no addresses`, ({ command }) => command.recordOffer({ kind: `answered`, value: { enabled: false } })],
        [`an offer that never answered`, ({ command }) => command.recordOffer({ kind: `unreachable` })],
    ])(`mints nothing for %s`, async (_, arrange) => {
        const staged = stage();
        arrange(staged);
        staged.row.created.value = sandboxSummary({ id: `a` });
        await nextTick();
        await advanceTimersByTimeAsync(1_000);
        expect(staged.setupCode).not.toHaveBeenCalled();
    });

    it(`restarts the handoff on a fresh code`, async () => {
        const { row, command } = stage();
        const handoff = () => ({ copied: command.copied.value, launched: command.launched.value, claimedAt: row.claimedAt.value });
        row.created.value = sandboxSummary({ id: `a` });
        command.copied.value = true;
        command.launched.value = true;
        row.claimedAt.value = `2026-09-23T10:00:00Z`;
        command.remint();
        await advanceTimersByTimeAsync(0);
        expect(handoff()).toEqual({ copied: false, launched: false, claimedAt: null });
    });

    it(`drops a code minted for a row the reader has since left`, async () => {
        const { setupCode, row, command } = stage();
        const minting = Promise.withResolvers<SetupCode>();
        setupCode.mockReturnValueOnce(minting.promise);
        row.created.value = sandboxSummary({ id: `a` });
        command.remint();
        row.created.value = sandboxSummary({ id: `b` });
        minting.resolve(code(`a`));
        await advanceTimersByTimeAsync(0);
        expect(command.mintedFor.value).toBe(undefined);
        expect(command.commandReady.value).toBe(false);
    });
});

describe(`a mint that fails`, () => {
    it(`reads a missing route as a platform with no addresses`, async () => {
        const { setupCode, row, command } = stage();
        setupCode.mockRejectedValueOnce(Object.assign(new Error(`not found`), { status: 404 }));
        row.created.value = sandboxSummary({ id: `a` });
        command.remint();
        await advanceTimersByTimeAsync(0);
        expect({ available: command.intenticAvailable.value, addressless: command.addressless.value }).toEqual({
            available: false,
            addressless: true,
        });
        expect(command.setupError.value).toBe(undefined);
    });

    it(`says so for the target on screen, and the retry mints again`, async () => {
        const { setupCode, row, command } = stage();
        setupCode.mockRejectedValueOnce(new Error(`platform down`));
        row.created.value = sandboxSummary({ id: `a` });
        command.remint();
        await advanceTimersByTimeAsync(0);
        expect(command.setupError.value).toEqual({
            tone: `danger`,
            title: `Couldn't prepare your install command. Try again.`,
            detail: `platform down`,
        });
        command.remint();
        await advanceTimersByTimeAsync(0);
        expect(command.setupError.value).toBe(undefined);
        expect(command.setup.value).toEqual(code(`a`));
    });
});

describe(`the lane's own state`, () => {
    it(`records a lost offer as unknown rather than as a no`, () => {
        const { command } = stage();
        command.recordOffer({ kind: `unreachable` });
        expect({ read: command.addressRead.value, available: command.intenticAvailable.value }).toEqual({
            read: { kind: `unreachable` },
            available: undefined,
        });
    });

    it(`forgets the code and its handoff for a new sandbox`, async () => {
        const { row, command } = stage();
        row.created.value = sandboxSummary({ id: `a` });
        command.remint();
        await advanceTimersByTimeAsync(0);
        command.copied.value = true;
        command.forget();
        expect({ setup: command.setup.value, mintedFor: command.mintedFor.value, copied: command.copied.value }).toEqual({
            setup: null,
            mintedFor: undefined,
            copied: false,
        });
    });

    it(`mints nothing after the page is gone`, async () => {
        const { setupCode, row, scope } = stage();
        row.created.value = sandboxSummary({ id: `a` });
        await nextTick();
        scope.stop();
        await advanceTimersByTimeAsync(1_000);
        expect(setupCode).not.toHaveBeenCalled();
    });
});
