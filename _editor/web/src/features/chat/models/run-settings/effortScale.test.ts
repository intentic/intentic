import { describe, it, expect, beforeEach, mock } from "bun:test";
import { Conversation } from "../../session/conversation";
import { clampEffort, effortsFor } from "./effortScale";
import { providerModels } from "../../accounts/providerCatalog";
import { fakeSandboxRpc } from "../../../../testing/sandboxRpcFake";

// Nothing here sends a turn; stubbed only so importing Conversation doesn't pull in the daemon client. Any call it
// did make would throw naming its procedure.
mock.module("../../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc() }));

// Effort scale is a property of the model, not the provider (Kimi K2.7 stops at 'high', K3 at 'max'), so a pick carried
// across models is routinely off-scale. Every read goes through the clamp.
describe(`the effort scale`, () => {
    const values = (options: { value: string }[]): string[] => options.map((option) => option.value);

    beforeEach(() => {
        providerModels.value = {
            ...providerModels.value,
            claude: [{ label: `Opus 5`, value: `claude-opus-5`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] }],
            kimi: [{ label: `Kimi K3`, value: `kimi-k3`, efforts: [`low`, `high`, `max`] }],
        };
    });

    // Max is removed only for the one pair Anthropic refuses (Claude, thinking off); any other provider or an unset
    // thinking keeps it.
    it(`takes Max away only where the API refuses it: Claude with thinking switched off`, () => {
        expect(values(effortsFor(`claude`, `claude-opus-5`, true))).toContain(`max`);
        // The run-button case: nothing pinned the thinking, so nothing has been turned off.
        expect(values(effortsFor(`claude`, `claude-opus-5`, undefined))).toContain(`max`);
        expect(values(effortsFor(`claude`, `claude-opus-5`, false))).not.toContain(`max`);

        /* Absent and enabled settings use the same offer. */
        expect(effortsFor(`claude`, `claude-opus-5`, undefined)).toEqual(effortsFor(`claude`, `claude-opus-5`, true));
        expect(effortsFor(`claude`, `claude-opus-5`, false)).not.toEqual(effortsFor(`claude`, `claude-opus-5`, undefined));
        // Dropping the top rung must not disturb the rest of the scale.
        expect(values(effortsFor(`claude`, `claude-opus-5`, false))).toEqual([`low`, `medium`, `high`, `xhigh`]);
        // Another vendor's published scale is that vendor's business, thinking setting or not.
        expect(values(effortsFor(`kimi`, `kimi-k3`, false))).toEqual([`low`, `high`, `max`]);
    });

    // An unpublished provider gets the floor tiers, never 'max': that's a rung a provider must claim itself. Claude's
    // floor
    // is the documented exception and keeps it.
    it(`invents no top rung for a provider that has not published one, and keeps Claude's`, () => {
        expect(values(effortsFor(`codex`, `gpt-5-codex`, true))).toEqual([`low`, `medium`, `high`, `xhigh`]);
        expect(values(effortsFor(`grok`, `grok-5`, undefined))).toEqual([`low`, `medium`, `high`, `xhigh`]);
        expect(values(effortsFor(`claude`, `claude-unlisted-model`, undefined))).toEqual([`low`, `medium`, `high`, `xhigh`, `max`]);
    });

    // Codex's 5.6 line reaches two rungs above the floor (model/list publishes max, and ultra on Sol/Terra/Astra).
    // A published scale is the model's own, so the picker draws every rung of it.
    it(`draws the whole ladder a model publishes, up to Ultra`, () => {
        providerModels.value = {
            ...providerModels.value,
            codex: [{ label: `GPT-5.6-Sol`, value: `gpt-5.6-sol`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`, `ultra`] }],
        };
        expect(effortsFor(`codex`, `gpt-5.6-sol`, undefined).at(-1)).toEqual({ label: `Ultra`, value: `ultra` });
        expect(clampEffort(`ultra`, `codex`, `gpt-5.6-sol`, undefined)).toBe(`ultra`);
        // Ultra is above Max, so a model that stops at Max takes Max rather than the bottom of its own scale.
        expect(clampEffort(`ultra`, `kimi`, `kimi-k3`, undefined)).toBe(`max`);
    });

    // The daemon's live tier list doesn't know this turn's thinking setting, so it needs the same filter as the static
    // fallback.
    it(`filters the daemon's live tier list by thinking too`, () => {
        providerModels.value = { ...providerModels.value, claude: [{ label: `Opus 5`, value: `claude-opus-5`, efforts: [`high`, `xhigh`, `max`] }] };
        expect(values(effortsFor(`claude`, `claude-opus-5`, true))).toEqual([`high`, `xhigh`, `max`]);
        expect(values(effortsFor(`claude`, `claude-opus-5`, false))).toEqual([`high`, `xhigh`]);
    });

    // An ACP agent owns its own reasoning settings; with no scale to offer there is nothing to clamp against.
    it(`offers an ACP provider no scale, and leaves its effort alone`, () => {
        expect(effortsFor(`my-acp-agent`, `whatever`, true)).toEqual([]);
        expect(clampEffort(`xhigh`, `my-acp-agent`, `whatever`, true)).toBe(`xhigh`);
    });

    it(`drops a pick to the strongest tier the model actually offers`, () => {
        // 'xhigh' carried onto Kimi's low/high scale would otherwise light no segment.
        expect(clampEffort(`xhigh`, `kimi`, `kimi-k3`, true)).toBe(`high`);
        expect(clampEffort(`medium`, `kimi`, `kimi-k3`, true)).toBe(`low`);
        // A tier the model publishes rides untouched, top rung included; one below the whole scale takes the weakest.
        expect(clampEffort(`max`, `kimi`, `kimi-k3`, true)).toBe(`max`);
        expect(clampEffort(`low`, `kimi`, `kimi-k3`, true)).toBe(`low`);
        expect(clampEffort(`minimal`, `kimi`, `kimi-k3`, true)).toBe(`low`);
    });

    it(`clamps a conversation's effort at every read, and keeps the pick behind it`, () => {
        const conversation = new Conversation(`c-effort`);
        conversation.selection.apply({ kind: `set`, picks: { provider: `kimi`, model: `kimi-k3`, effortPick: `xhigh` } });
        expect(conversation.selection.effort.value).toBe(`high`);

        // Back on a model whose scale has it, the pick returns: a smaller model borrows it, doesn't ratchet it down.
        conversation.selection.apply({ kind: `set`, picks: { provider: `claude`, model: `claude-opus-5` } });
        expect(conversation.selection.effort.value).toBe(`xhigh`);
    });

    // The catalog arrives after a conversation is seeded, so no setter runs at the moment the scale changes.
    it(`follows a catalog that loads under a seeded conversation`, () => {
        providerModels.value = { ...providerModels.value, kimi: [] };
        const conversation = new Conversation(`c-late-catalog`);
        conversation.selection.apply({ kind: `set`, picks: { provider: `kimi`, model: `kimi-k3`, effortPick: `xhigh` } });
        // Pre-load, the static scale has 'xhigh' and nothing is wrong with the pick.
        expect(conversation.selection.effort.value).toBe(`xhigh`);

        providerModels.value = { ...providerModels.value, kimi: [{ label: `Kimi K3`, value: `kimi-k3`, efforts: [`low`, `high`] }] };
        expect(conversation.selection.effort.value).toBe(`high`);
    });

    // 'max' leaves Claude's scale the moment extended thinking goes off: the API rejects the pair with a 400.
    it(`drops Max when thinking is switched off`, () => {
        const conversation = new Conversation(`c-thinking`);
        conversation.selection.apply({ kind: `set`, picks: { model: `claude-opus-5`, effortPick: `max`, thinking: true } });
        expect(conversation.selection.effort.value).toBe(`max`);
        conversation.selection.apply({ kind: `set`, picks: { thinking: false } });
        expect(conversation.selection.effort.value).toBe(`xhigh`);
    });
});
