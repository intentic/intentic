import { describe, expect, it } from "vitest";
import { conversationIdOf, isRunConversation, parseResult, runIdAt, runManifestOf, storyDir } from "./runs";
import type { Story } from "./stories";

// The daemon's own guard on AgentTurn.conversationId — it lands in branch names (agent/<id>) and filesystem
// paths, so a violation is not a validation error the UI can retry past.
const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const story = (slug: string): Story => ({ path: `app/docs/user-stories/${slug}.md`, slug, title: slug, group: `` });

describe(`conversationIdOf`, () => {
    it(`produces an id the daemon accepts`, () => {
        expect(conversationIdOf(runIdAt(1_800_000_000_000), `01-sign-in`)).toMatch(CONVERSATION_ID);
    });

    it(`stays inside the 64-character limit for the longest slug storiesOf can produce`, () => {
        const id = conversationIdOf(runIdAt(1_800_000_000_000), `s`.repeat(40));
        expect(id.length).toBeLessThanOrEqual(64);
        expect(id).toMatch(CONVERSATION_ID);
    });

    it(`never ends on the separator a truncation could have landed on`, () => {
        expect(conversationIdOf(`r`, `${`a`.repeat(58)}-tail`)).not.toMatch(/-$/);
    });

    it(`keeps the run id intact so a card can always be attributed back to its run`, () => {
        const runId = runIdAt(1_800_000_000_000);
        expect(isRunConversation(runId, conversationIdOf(runId, `s`.repeat(40)))).toBe(true);
    });

    it(`does not match another run's conversations`, () => {
        expect(isRunConversation(runIdAt(1_800_000_000_000), conversationIdOf(runIdAt(1_800_000_001_000), `login`))).toBe(false);
    });
});

describe(`runIdAt`, () => {
    it(`sorts chronologically as a string, so run directories list in order`, () => {
        expect(runIdAt(1_800_000_000_000) < runIdAt(1_800_000_001_000)).toBe(true);
    });
});

describe(`runManifestOf`, () => {
    const manifest = runManifestOf({
        runId: `rabc`,
        repo: `app`,
        createdAt: 1_800_000_000_000,
        baseUrl: `http://localhost:5173`,
        provider: `claude`,
        model: `claude-sonnet-4-5`,
        stories: [story(`login`), story(`checkout`)],
    });

    it(`records each story's conversation id rather than leaving it to be re-derived later`, () => {
        expect(manifest.stories).toEqual([
            { slug: `login`, path: `app/docs/user-stories/login.md`, title: `login`, conversationId: `xt-rabc-login` },
            { slug: `checkout`, path: `app/docs/user-stories/checkout.md`, title: `checkout`, conversationId: `xt-rabc-checkout` },
        ]);
    });

    it(`omits an unset model instead of writing an empty string`, () => {
        const withoutModel = runManifestOf({ ...manifest, model: ``, stories: [story(`login`)] });
        expect(`model` in withoutModel).toBe(false);
    });
});

describe(`storyDir`, () => {
    it(`sits under .intentic, outside every repo — no git noise, nothing to land`, () => {
        expect(storyDir(`rabc`, `login`)).toBe(`.intentic/exploratory/rabc/login`);
    });
});

describe(`parseResult`, () => {
    it(`accepts a well-formed verdict`, () => {
        expect(parseResult(`{"story":"login","verdict":"fail"}`)?.verdict).toBe(`fail`);
    });

    it.each([`not json`, `{"story":"login"}`, `{"verdict":"probably"}`, `null`])(`treats %s as no result yet rather than a verdict`, (text) => {
        expect(parseResult(text)).toBeUndefined();
    });
});
