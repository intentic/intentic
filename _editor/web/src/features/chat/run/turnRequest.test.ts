import { turnRequestBody } from "./turnRequest";

// Baseline turn settings reused across the request-shape tests below.
const settings = {
    agent: `claude`,
    harness: `native`,
    account: undefined,
    actsAs: undefined,
    startIn: undefined,
    model: `opus`,
    effort: `high`,
    thinking: false,
    fast: false,
} as const;

// Wire body shape: every assertion is about an omission, since that's where the daemon's defaults live (unset
// means its own catalog default, native loop, /work).
describe(`turnRequestBody`, () => {
    const base = {
        messageId: `m-1`,
        text: `do the thing`,
        conversationId: `c1`,
        title: null,
        isolated: false,
        mode: `plan`,
        settings,
        registered: false,
        session: undefined,
        forkOf: undefined,
        attachmentPaths: [] as string[],
        mentionedPaths: [] as string[],
        editorContext: undefined,
    } as const;

    // Serializes through JSON.stringify, so assertions see the same omissions the daemon receives.
    const wire = (body: object): Record<string, unknown> => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

    it(`drops an empty model so the daemon resolves its provider's live catalog default`, () => {
        const sent = wire(turnRequestBody({ ...base, settings: { ...settings, model: `` } }));

        expect(sent).not.toHaveProperty(`model`);
        expect(wire(turnRequestBody(base))).toMatchObject({ model: `opus` });
    });

    // The daemon answers a resend under the same id with what it did the first time, rather than delivering it twice.
    it(`carries the id this window gave the message`, () => {
        expect(wire(turnRequestBody(base))).toMatchObject({ messageId: `m-1`, prompt: `do the thing` });
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

    // Which session a turn goes on in is the daemon's to say (routing.ts). The id rides only for a daemon older than that,
    // which resumes exactly what it is sent, and for a past session resumed from history, which no record holds yet.
    it(`carries the held session id as a fallback while the selection reads as continuing it, and nothing otherwise`, () => {
        const session = { id: `s-1`, provider: `claude`, account: undefined, harness: `native` } as const;
        expect(wire(turnRequestBody({ ...base, session }))).toMatchObject({ sessionId: `s-1` });

        expect(wire(turnRequestBody(base))).not.toHaveProperty(`sessionId`);
        expect(wire(turnRequestBody({ ...base, session, settings: { ...settings, harness: `claude-code` } }))).not.toHaveProperty(`sessionId`);
        expect(wire(turnRequestBody({ ...base, session, settings: { ...settings, agent: `codex` } }))).not.toHaveProperty(`sessionId`);
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

    // A window's account can be older than the conversation's (another window moved it, a limit move did, the daemon
    // moved it off an account that can no longer serve), and naming it on a turn that only continues the conversation
    // took it back there: an account switch nobody chose, and a pin the daemon may not move off a refused seat.
    describe(`the account`, () => {
        const session = { id: `s-1`, provider: `claude`, account: `acct-a`, harness: `native` } as const;
        const onA = { ...settings, account: `acct-a` };

        it(`is left to the daemon where the selection holds what the daemon last reported`, () => {
            expect(wire(turnRequestBody({ ...base, registered: true, settings: onA, session }))).not.toHaveProperty(`account`);
            // Another loop on the same provider keeps the account: it belongs to the provider, not to the loop.
            expect(wire(turnRequestBody({ ...base, registered: true, settings: { ...onA, harness: `claude-code` }, session }))).not.toHaveProperty(`account`);
        });

        // A pick on a conversation the daemon holds goes as switchAccount; it rides the turn too until the daemon reports
        // it back, which is how a daemon too old for the route, or busy with a turn when it was asked, learns it.
        it(`is named for a pick the daemon has not reported back`, () => {
            expect(wire(turnRequestBody({ ...base, registered: true, settings: { ...settings, account: `acct-b` }, session }))).toMatchObject({
                account: `acct-b`,
            });
        });

        // The daemon holds a conversation off an account its organisation turned off, and a turn naming none is held
        // there again. Picking that account by hand is the person trying it: named, so it runs, and its answer lifts
        // the mark. THE FAILURE THIS PREVENTS: the pick equalled the recorded account, so it was dropped and held again.
        it(`is named when the person picked it by hand for this turn, even the one the daemon already records`, () => {
            expect(wire(turnRequestBody({ ...base, registered: true, settings: { ...onA, accountPicked: true }, session }))).toMatchObject({
                account: `acct-a`,
            });
            expect(wire(turnRequestBody({ ...base, registered: true, settings: { ...onA, accountPicked: true }, session, box: `sbx-there` }))).not.toHaveProperty(
                `account`,
            );
        });

        it(`is named where there is no record to follow: a first turn, another provider, a window holding no session`, () => {
            expect(wire(turnRequestBody({ ...base, registered: false, settings: onA, session }))).toMatchObject({ account: `acct-a` });
            expect(wire(turnRequestBody({ ...base, registered: true, settings: { ...onA, agent: `codex` }, session }))).toMatchObject({ account: `acct-a` });
            expect(wire(turnRequestBody({ ...base, registered: true, settings: onA, session: undefined }))).toMatchObject({ account: `acct-a` });
        });
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

    // Apart on the wire: the daemon refuses a turn over a chip it can't resolve and drops a mention it can't,
    // so merging them would let a `@path` inside a paste kill the turn.
    it(`carries mentioned paths in their own field, never among the chosen attachments`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`mentions`);

        const sent = wire(turnRequestBody({ ...base, attachmentPaths: [`a.png`], mentionedPaths: [`src/app.ts`] }));
        expect(sent).toMatchObject({ attachments: [`a.png`], mentions: [`src/app.ts`] });
    });
});
