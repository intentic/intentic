import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ref } from "vue";
import { freshImport } from "@intentic/testing/bun";
import { TrialStatusSchema } from "@intentic/sandbox-contract";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import type { ProcedureInput, ProcedureOutput } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { activeSandboxId } from "../../sandbox/overview/activeSandbox";

// The composer's picks are one answer per account, not per browser window; this suite proves it by making the
// picks here and opening a second window's copy of the modules that hold them over the same storage. Shares a
// rule with rememberedAccountFor: a thin catalog read costs one substitution, never the pick itself.

const TWO = [
    { id: `first`, label: `Claude one`, connectedAt: 1 },
    { id: `second`, label: `Claude two`, connectedAt: 2 },
];

// Two Claude accounts, a Cursor one so a second-provider pick is actually runnable (an unrunnable pick would resolve
// elsewhere and hide whether it was remembered), and every other connection read answering empty.
const providerModels = mock<(input: ProcedureInput<`providers.models`>) => Promise<ProcedureOutput<`providers.models`>>>();
mock.module("../../sandbox/client/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        accounts: {
            accounts: async ({ provider }) => ({
                accounts: provider === `claude` ? TWO : provider === `cursor` ? [{ id: `cur`, label: `Cursor`, connectedAt: 1 }] : [],
            }),
        },
        translator: { accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [] }) },
        usage: { refreshPlanLimits: async () => ({ ok: true, held: [] }) },
        agent: { refusals: async () => ({ refusals: {} }), commands: async () => ({ commands: [] }) },
        providers: { list: async () => ({ native: [], agents: [], endpoints: [] }), models: providerModels },
        endpoints: { trial: async () => TrialStatusSchema.parse({ available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` }) },
    }),
}));
mock.module("../../../app/analytics", () => ({ track: mock() }));
// The app's one active-sandbox ref, as every store reads it.
activeSandboxId.value = `sb1`;
mock.module("../../sandbox/client/useSandbox", () => {
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

// The Claude catalog, as the daemon serves it; every other provider's catalog is refused.
const mockDaemon = (claudeModels = [`claude-fable-5`, `claude-opus-4-6`]): void => {
    providerModels.mockImplementation(async ({ provider }) => {
        if (provider !== `claude`) {
            throw new SandboxHttpError(404, `Request failed (404).`);
        }
        return { models: claudeModels.map((id) => ({ id, label: id })), default: `claude-fable-5` };
    });
};

mockDaemon();
const { useChat } = await import("../run/useChat");
const { loadAccountStatus } = await import("../accounts/useChat-accounts");
const { loadProviderModels } = await import("../models/useChat-catalog");

// A window that opens now: the two modules holding the picks, evaluated again over the same storage, which is
// what a second copy of the app reads at load. bun has no module-registry reset, so the whole graph cannot be
// forked; these two are where every persisted pick lives, and Conversation seeds from exactly them.
const openWindow = async () => {
    const turn = await freshImport<typeof import("../run/turnDefaults")>("../run/turnDefaults", import.meta.url);
    const accounts = await freshImport<typeof import("../accounts/accountPreference")>("../accounts/accountPreference", import.meta.url);
    return { turn, accounts };
};

describe(`the composer's remembered picks`, () => {
    beforeEach(async () => {
        local.clear();
        session.clear();
        mockDaemon();
        await loadAccountStatus();
    });

    it(`seeds a new chat from the pick made in ANOTHER window`, async () => {
        // The chat, popped out into a window of its own, where the user makes their picks.
        useChat().selectModel({ provider: `claude`, value: `claude-opus-4-6` });
        useChat().effort.value = `high`;
        useChat().active.value.selection.apply({ kind: `selectAccount`, account: `second` });

        // The fleet board's window, opening on the same account: "New agent" there starts on those picks.
        const board = await openWindow();
        expect(board.turn.rememberedModelFor(`claude`)).toBe(`claude-opus-4-6`);
        expect(board.turn.turnDefaults.effort.value).toBe(`high`);
        expect(board.accounts.accountPicks().value[`claude`]).toBe(`second`);
    });

    // A pick is a pair, provider and model, and both halves travel; picking a second model on the same
    // provider must still record the provider.
    it(`carries the provider of the pick, not only its model`, async () => {
        useChat().selectModel({ provider: `cursor`, value: `composer-2.5` });
        // The second pick keeps the provider, the ordinary case.
        useChat().selectModel({ provider: `cursor`, value: `composer-2.5-fast` });

        const board = await openWindow();
        expect([board.turn.rememberedProviderFor(), board.turn.rememberedModelFor(`cursor`)]).toEqual([`cursor`, `composer-2.5-fast`]);
    });

    it(`keeps a pick a thin catalog read does not carry, and honours it when the catalog does`, async () => {
        useChat().selectModel({ provider: `claude`, value: `claude-opus-4-6` });
        // A pick fires its own catalog read; it has to land before the thin one replaces it, or the reads collapse.
        await loadProviderModels(`claude`);

        // A thin catalog is what a provider serves while its own model discovery is still coming up.
        mockDaemon([`claude-fable-5`]);
        await loadProviderModels(`claude`);
        // The chat cannot send on a model this list doesn't offer, so it opens on the default.
        expect((await openWindow()).turn.rememberedModelFor(`claude`)).toBe(`claude-fable-5`);

        // The pick behind it is untouched, so the full catalog restores it.
        mockDaemon();
        await loadProviderModels(`claude`);
        expect((await openWindow()).turn.rememberedModelFor(`claude`)).toBe(`claude-opus-4-6`);
    });
});
