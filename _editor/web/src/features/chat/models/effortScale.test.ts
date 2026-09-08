import { beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "../session/conversation";
import { clampEffort, effortsFor } from "./effortScale";
import { providerModels } from "../accounts/providerCatalog";

// Nothing here sends a turn; stubbed only so importing Conversation doesn't pull in the daemon client.
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxRequest: vi.fn() }));

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
        conversation.provider.value = `kimi`;
        conversation.model.value = `kimi-k3`;
        conversation.effortPick.value = `xhigh`;
        expect(conversation.effort.value).toBe(`high`);

        // Back on a model whose scale has it, the pick returns: a smaller model borrows it, doesn't ratchet it down.
        conversation.provider.value = `claude`;
        conversation.model.value = `claude-opus-5`;
        expect(conversation.effort.value).toBe(`xhigh`);
    });

    // The catalog arrives after a conversation is seeded, so no setter runs at the moment the scale changes.
    it(`follows a catalog that loads under a seeded conversation`, () => {
        providerModels.value = { ...providerModels.value, kimi: [] };
        const conversation = new Conversation(`c-late-catalog`);
        conversation.provider.value = `kimi`;
        conversation.model.value = `kimi-k3`;
        conversation.effortPick.value = `xhigh`;
        // Pre-load, the static scale has 'xhigh' and nothing is wrong with the pick.
        expect(conversation.effort.value).toBe(`xhigh`);

        providerModels.value = { ...providerModels.value, kimi: [{ label: `Kimi K3`, value: `kimi-k3`, efforts: [`low`, `high`] }] };
        expect(conversation.effort.value).toBe(`high`);
    });

    // 'max' leaves Claude's scale the moment extended thinking goes off: the API rejects the pair with a 400.
    it(`drops Max when thinking is switched off`, () => {
        const conversation = new Conversation(`c-thinking`);
        conversation.model.value = `claude-opus-5`;
        conversation.effortPick.value = `max`;
        conversation.thinking.value = true;
        expect(conversation.effort.value).toBe(`max`);
        conversation.thinking.value = false;
        expect(conversation.effort.value).toBe(`xhigh`);
    });
});
