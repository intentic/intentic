import { describe, expect, it } from "vitest";
import { turnRequestBody } from "./turnRequest";

// The turn selection a send runs under — the same shape the composer captures.
const settings = {
    agent: `claude`,
    harness: `native`,
    account: undefined,
    actsAs: undefined,
    model: `opus`,
    effort: `high`,
    thinking: false,
    fast: false,
} as const;

/* The wire body on its own. Every assertion here is about an OMISSION, because that is where the daemon's
 * defaults live: a key that isn't sent is the daemon resolving its own catalog default, running the native
 * loop, or working on /work rather than in a worktree. Sending an empty string instead would pin the turn to
 * nothing at all. */
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

    // JSON.stringify is what actually applies the omissions, so assert on what crosses the wire.
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

    it(`sends isolated only when the conversation owns a worktree`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`isolated`);
        expect(wire(turnRequestBody({ ...base, isolated: true }))).toMatchObject({ isolated: true });
    });

    /* An omitted session id is the whole of what a switched turn says. No transcript rides with it — the daemon
     * seeds the replacement from its own record of the conversation — so "starts a fresh session" and "resumes"
     * are one key present or absent, with nothing to keep consistent between them. */
    it(`carries a resumed session id, and nothing at all in its place when there is none`, () => {
        const resumed = wire(turnRequestBody({ ...base, resume: { id: `s-1`, provider: `claude`, account: undefined, harness: `native` } }));
        expect(resumed).toMatchObject({ sessionId: `s-1` });

        expect(wire(turnRequestBody(base))).not.toHaveProperty(`sessionId`);
    });

    // A fork is the one turn that has to say where its conversation came from: it is new daemon-side, so
    // nothing there knows what it should start with until this names the cut — nor which files it starts on.
    it(`names a fork's origin and its file choice, and only for the fork's own first turn`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`forkOf`);
        expect(wire(turnRequestBody({ ...base, forkOf: { conversationId: `c0`, keep: 4, files: `then` } }))).toMatchObject({
            forkOf: { conversationId: `c0`, keep: 4, files: `then` },
        });
    });

    /* THE PERSONA IS THE ONE OMISSION THAT IS NOT A DEFAULT BUT A POSTURE. An absent `actsAs` on an attended
     * turn keeps every connected account; the same absence on an unattended wake reaches none. So this key must
     * be missing when nobody is picked rather than sent as an empty string — a named card the daemon cannot
     * find is the fail-closed case, and "" names nothing at all. */
    it(`carries the persona only once one is picked`, () => {
        expect(wire(turnRequestBody(base))).not.toHaveProperty(`actsAs`);
        expect(wire(turnRequestBody({ ...base, settings: { ...settings, actsAs: `work` } }))).toMatchObject({ actsAs: `work` });
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
