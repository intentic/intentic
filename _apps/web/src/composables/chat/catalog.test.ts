import { expect, test, vi } from "vitest";
import { approvalsFor, effortsFor } from "./catalog";
import { providerModels } from "./conversation";

/* The plan card's approve buttons. Approving a plan is where a conversation's posture is re-chosen, so the
 * order matters: the mode the conversation was ALREADY in has to lead, or an agent that talked itself into
 * planning quietly costs the user the permissions they granted it. */

// catalog.ts pulls in conversation.ts for the live model catalogs; stub its side-effecting seams so the import
// is inert.
vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn() }));
vi.mock("./useChat", () => ({ loadProviderModels: vi.fn(async () => {}) }));

test("the conversation's own posture leads, and every other posture stays one click away", () => {
    expect(approvalsFor(`bypassPermissions`).map((approval) => approval.mode)).toEqual([`bypassPermissions`, `acceptEdits`, `default`]);
    expect(approvalsFor(`default`).map((approval) => approval.mode)).toEqual([`default`, `acceptEdits`, `bypassPermissions`]);
    expect(approvalsFor(`acceptEdits`)[0]).toEqual({ mode: `acceptEdits`, label: `Yes, and auto-accept edits` });
});

test("a conversation whose own pick is plan has nothing to restore, so auto-accept leads", () => {
    expect(approvalsFor(`plan`).map((approval) => approval.mode)).toEqual([`acceptEdits`, `bypassPermissions`, `default`]);
    // 'plan' is never an approval target — approving IS the exit from planning.
    expect(approvalsFor(`plan`).some((approval) => approval.mode === `plan`)).toBe(false);
});

/* The effort scale. 'max' is the one tier that isn't always sendable: Codex/Grok have no such rung, and
 * Claude's API rejects it outright when extended thinking is off. Offering it in either case hands the user a
 * pick that fails the turn with a 400 before the model reads a word of it. */

const values = (options: { value: string }[]): string[] => options.map((option) => option.value);

test("the static scale offers Max only to Claude, and only with thinking on", () => {
    expect(values(effortsFor(`claude`, `claude-opus-5`, true))).toContain(`max`);
    expect(values(effortsFor(`claude`, `claude-opus-5`, false))).not.toContain(`max`);
    expect(values(effortsFor(`codex`, `gpt-5-codex`, true))).not.toContain(`max`);
    // Dropping the top rung must not disturb the rest of the scale.
    expect(values(effortsFor(`claude`, `claude-opus-5`, false))).toEqual([`low`, `medium`, `high`, `xhigh`]);
});

// The daemon reports a model's tiers without knowing this turn's thinking setting, so the live list needs the
// same filter as the static fallback — otherwise the constraint only holds until a catalog loads.
test("the daemon's live tier list is filtered by thinking too", () => {
    providerModels.value = { ...providerModels.value, claude: [{ label: `Opus 5`, value: `claude-opus-5`, efforts: [`high`, `xhigh`, `max`] }] };
    expect(values(effortsFor(`claude`, `claude-opus-5`, true))).toEqual([`high`, `xhigh`, `max`]);
    expect(values(effortsFor(`claude`, `claude-opus-5`, false))).toEqual([`high`, `xhigh`]);
});
