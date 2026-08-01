import { beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./conversation";
import { clampEffort, effortsFor } from "./effortScale";
import { providerModels } from "./providerCatalog";

// Nothing here sends a turn; the stub is only so importing a Conversation doesn't pull the daemon client's
// environment in behind it.
vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn() }));

/* The reasoning-effort scale, which belongs to the MODEL and not to the provider: Kimi K3 stops at 'high' where
 * Claude runs to 'max', so a pick carried across a model switch is routinely off-scale. Every read of a
 * conversation's effort goes through the clamp, because an off-scale tier both leaves the composer's segments
 * with nothing lit and sends the runtime a level it never published. */
describe(`the effort scale`, () => {
    const values = (options: { value: string }[]): string[] => options.map((option) => option.value);

    beforeEach(() => {
        providerModels.value = {
            ...providerModels.value,
            claude: [{ label: `Opus 5`, value: `claude-opus-5` }],
            kimi: [{ label: `Kimi K3`, value: `kimi-k3`, efforts: [`low`, `high`, `max`] }],
        };
    });

    it(`offers Max only to Claude, and only with thinking on`, () => {
        expect(values(effortsFor(`claude`, `claude-opus-5`, true))).toContain(`max`);
        expect(values(effortsFor(`claude`, `claude-opus-5`, false))).not.toContain(`max`);
        expect(values(effortsFor(`codex`, `gpt-5-codex`, true))).not.toContain(`max`);
        // Dropping the top rung must not disturb the rest of the scale.
        expect(values(effortsFor(`claude`, `claude-opus-5`, false))).toEqual([`low`, `medium`, `high`, `xhigh`]);
    });

    // The daemon reports a model's tiers without knowing this turn's thinking setting, so the live list needs
    // the same filter as the static fallback — otherwise the constraint only holds until a catalog loads.
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
        // The bug this exists for: 'xhigh' carried onto Kimi, whose scale is low/high, lit no segment at all.
        expect(clampEffort(`xhigh`, `kimi`, `kimi-k3`, true)).toBe(`high`);
        expect(clampEffort(`max`, `kimi`, `kimi-k3`, true)).toBe(`high`);
        expect(clampEffort(`medium`, `kimi`, `kimi-k3`, true)).toBe(`low`);
        // A tier the model publishes rides untouched, and one below its whole scale takes the weakest rung.
        expect(clampEffort(`low`, `kimi`, `kimi-k3`, true)).toBe(`low`);
        expect(clampEffort(`minimal`, `kimi`, `kimi-k3`, true)).toBe(`low`);
    });

    it(`clamps a conversation's effort at every read, and keeps the pick behind it`, () => {
        const conversation = new Conversation(`c-effort`);
        conversation.provider.value = `kimi`;
        conversation.model.value = `kimi-k3`;
        conversation.effortPick.value = `xhigh`;
        expect(conversation.effort.value).toBe(`high`);

        // Back on a model whose scale has it, the user's own pick returns — a smaller model borrows the
        // selection, it doesn't ratchet it down.
        conversation.provider.value = `claude`;
        conversation.model.value = `claude-opus-5`;
        expect(conversation.effort.value).toBe(`xhigh`);
    });

    // The catalog arrives AFTER a conversation is seeded, so no setter runs at the moment the scale changes.
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

    // 'max' leaves Claude's own scale the moment extended thinking goes off — the API rejects the pair with a 400.
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
