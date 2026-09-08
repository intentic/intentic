import { describe, expect, it } from "vitest";
import { turnRequestBody } from "./turnRequest";

// Baseline turn settings reused across the request-shape tests below.
const settings = {
    agent: `claude`,
    harness: `native`,
    account: undefined,
    actsAs: undefined,
    model: `opus`,
    effort: `high`,
    thinking: false,
    fast: false,
    tierHold: false,
} as const;

// Wire body shape: every assertion is about an omission, since that's where the daemon's defaults live (unset
// means its own catalog default, native loop, /work).
describe(`turnRequestBody`, () => {
    const base = {
        text: `do the thing`,
        conversationId: `c1`,
        title: null,
        isolated: false,
        mode: `plan`,
        settings,
        resume: undefined,
        forkOf: undefined,
        attachmentPaths: [],
        editorContext: undefined,
    } as const;

    // Serializes through JSON.stringify, so assertions see the same omissions the daemon receives.
    const wire = (body: object): Record<string, unknown> => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

    it(`drops an empty model so the daemon resolves its provider's live catalog default`, () => {
        const sent = wire(turnRequestBody({ ...base, settings: { ...settings, model: `` } }));

        expect(sent).not.toHaveProperty(`model`);
        expect(wire(turnRequestBody(base))).toMatchObject({ model: `opus` });
    });

    it(`sends the harness only for claude-code, since native is the daemon's own default`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`harness`);
        expect(wire(turnRequestBody({ ...base, settings: { ...settings, harness: `claude-code` } }))).toMatchObject({ harness: `claude-code` });
    });

    it(`sends a placement only when the conversation was pointed at a runner`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`placement`);
        expect(wire(turnRequestBody({ ...base, runner: `rig` }))).toMatchObject({ placement: { kind: `runner`, id: `rig` } });
    });

    it(`sends isolated only when the conversation owns a worktree`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`isolated`);
        expect(wire(turnRequestBody({ ...base, isolated: true }))).toMatchObject({ isolated: true });
    });

    it(`carries a resumed session id, and nothing at all in its place when there is none`, () => {
        const resumed = wire(turnRequestBody({ ...base, resume: { id: `s-1`, provider: `claude`, account: undefined, harness: `native` } }));
        expect(resumed).toMatchObject({ sessionId: `s-1` });

        expect(wire(turnRequestBody(base))).not.toHaveProperty(`sessionId`);
    });

    it(`names a fork's origin and its file choice, and only for the fork's own first turn`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`forkOf`);
        expect(wire(turnRequestBody({ ...base, forkOf: { conversationId: `c0`, keep: 4, files: `then` } }))).toMatchObject({
            forkOf: { conversationId: `c0`, keep: 4, files: `then` },
        });
    });

    it(`carries the persona only once one is picked`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`actsAs`);
        expect(wire(turnRequestBody({ ...base, settings: { ...settings, actsAs: `work` } }))).toMatchObject({ actsAs: `work` });
    });

    it(`always states the tier hold, because absence there would leave an earlier hold standing`, () => {
        expect(wire(turnRequestBody(base))).toMatchObject({ tierHold: false });
        expect(wire(turnRequestBody({ ...base, settings: { ...settings, tierHold: true } }))).toMatchObject({ tierHold: true });
    });

    it(`sends no account of this box's when the turn runs in another sandbox`, () => {
        const settingsWithAccount = { ...settings, account: `acct-here` };
        expect(wire(turnRequestBody({ ...base, settings: settingsWithAccount }))).toMatchObject({ account: `acct-here` });
        expect(wire(turnRequestBody({ ...base, settings: settingsWithAccount, box: `sbx-there` }))).not.toHaveProperty(`account`);
    });

    it(`sends no persona and no editor context when the turn runs in another sandbox`, () => {
        const sent = wire(
            turnRequestBody({
                ...base,
                box: `sbx-there`,
                settings: { ...settings, actsAs: `work` },
                editorContext: { file: `src/app.ts` },
            }),
        );
        expect(sent).not.toHaveProperty(`actsAs`);
        expect(sent).not.toHaveProperty(`editorContext`);
    });

    it(`drops a runner placement when the turn runs in another sandbox`, () => {
        expect(wire(turnRequestBody({ ...base, runner: `rig`, box: `sbx-there` }))).not.toHaveProperty(`placement`);
    });

    it(`still names the provider and model when the turn runs in another sandbox`, () => {
        expect(wire(turnRequestBody({ ...base, box: `sbx-there` }))).toMatchObject({ agent: `claude`, model: `opus` });
    });

    it(`omits an absent title, attachments and editor context rather than sending empties`, () => {
        const bare = wire(turnRequestBody(base));
        expect(bare).not.toHaveProperty(`title`);
        expect(bare).not.toHaveProperty(`attachments`);
        expect(bare).not.toHaveProperty(`editorContext`);

        const full = wire(turnRequestBody({ ...base, title: `Do the thing`, attachmentPaths: [`a.png`], editorContext: { file: `src/app.ts` } }));
        expect(full).toMatchObject({ title: `Do the thing`, attachments: [`a.png`], editorContext: { file: `src/app.ts` } });
    });
});
