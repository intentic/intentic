import { describe, expect, it } from "vitest";
import {
    conversationIdOf,
    isShotPath,
    matchesStoryRevision,
    parseManifest,
    parseResult,
    reposOf,
    runIdAt,
    runManifestOf,
    storyDir,
    storyStanding,
    type StorySnapshot,
} from "./runs";

// The daemon's own format for AgentTurn.conversationId; used in branch names and filesystem paths.
const CONVERSATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const story = (slug: string, repo = `app`, group = ``): StorySnapshot => ({
    repo,
    path: `${repo}/docs/user-stories/${group === `` ? `` : `${group}/`}${slug}.md`,
    slug,
    title: slug,
    group,
    content: `# ${slug}\n\n## Acceptance criteria\n\n- ${slug} works\n`,
    criteria: [`${slug} works`],
});

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
        expect(conversationIdOf(runId, `s`.repeat(40)).startsWith(`xt-${runId}-`)).toBe(true);
    });

    it(`gives two runs of the same story different ids`, () => {
        expect(conversationIdOf(runIdAt(1_800_000_000_000), `login`)).not.toBe(conversationIdOf(runIdAt(1_800_000_001_000), `login`));
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
        createdAt: 1_800_000_000_000,
        targets: { "app/site": `http://localhost:4321`, api: `http://localhost:3000` },
        notes: { app: `Use the demo account` },
        pick: { agent: `claude`, model: `claude-sonnet-4-5` },
        stories: [story(`login`, `app`, `site`), story(`checkout`, `api`)],
    });

    it(`records each story's group and conversation id rather than leaving them to be re-derived later`, () => {
        expect(manifest.stories).toEqual([
            {
                slug: `login`,
                repo: `app`,
                group: `site`,
                path: `app/docs/user-stories/site/login.md`,
                title: `login`,
                conversationId: `xt-rabc-login`,
                content: `# login\n\n## Acceptance criteria\n\n- login works\n`,
                criteria: [`login works`],
            },
            {
                slug: `checkout`,
                repo: `api`,
                group: ``,
                path: `api/docs/user-stories/checkout.md`,
                title: `checkout`,
                conversationId: `xt-rabc-checkout`,
                content: `# checkout\n\n## Acceptance criteria\n\n- checkout works\n`,
                criteria: [`checkout works`],
            },
        ]);
        expect(manifest.launchFailures).toEqual({});
    });

    it(`keeps one address per story group`, () => {
        expect(manifest.targets).toEqual({ "app/site": `http://localhost:4321`, api: `http://localhost:3000` });
    });

    /* THE WHOLE PICK IS RECORDED, and it has to be: the fan-out is one session per story and Retry starts more
     * of them off this file minutes later, so a knob the reader chose and the manifest dropped would run the
     * first story the way they asked and every later one on the sandbox's defaults. Whatever was not chosen is
     * simply absent, which is how every reader of a pick spells "the model's own default". */
    it(`records the whole pick the reader configured`, () => {
        const pick = { agent: `claude`, model: `claude-sonnet-4-5`, account: `acc-1`, effort: `xhigh`, thinking: false, fast: true } as const;
        expect(runManifestOf({ ...manifest, pick, stories: [story(`login`)] }).pick).toEqual(pick);
    });
});

describe(`reposOf`, () => {
    it(`lists every repo a run touched once, in first-appearance order`, () => {
        const manifest = runManifestOf({
            runId: `rabc`,
            createdAt: 0,
            targets: {},
            notes: {},
            pick: { agent: `claude`, model: `claude-sonnet-4-5` },
            stories: [story(`login`, `api`), story(`checkout`, `app`), story(`profile`, `api`)],
        });
        expect(reposOf(manifest)).toEqual([`api`, `app`]);
    });
});

describe(`matchesStoryRevision`, () => {
    it(`keeps an old verdict off a promise that changed at the same path`, () => {
        const tested = story(`login`);
        expect(matchesStoryRevision(tested, tested.content)).toBe(true);
        expect(matchesStoryRevision(tested, `${tested.content}\n- A new promise`)).toBe(false);
        expect(matchesStoryRevision(tested, undefined)).toBe(false);
    });
});

describe(`storyDir`, () => {
    it(`sits under .intentic, outside every repo: no git noise, nothing to land`, () => {
        expect(storyDir(`rabc`, `login`)).toBe(`.intentic/records/artifacts/acceptance/rabc/login`);
    });
});

describe(`isShotPath`, () => {
    it(`accepts only a flat PNG inside the story's shots directory`, () => {
        expect(isShotPath(`shots/01-login.png`)).toBe(true);
        expect(isShotPath(`../01-login.png`)).toBe(false);
        expect(isShotPath(`shots/nested/01-login.png`)).toBe(false);
        expect(isShotPath(`https://example.com/01-login.png`)).toBe(false);
    });
});

// Pins that a malformed manifest returns undefined rather than throwing, since a half-written run.json is a normal
// sight while a run is starting.
describe(`parseManifest`, () => {
    it(`reads a manifest back`, () => {
        const source = runManifestOf({
            runId: `rabc`,
            createdAt: 7,
            targets: { app: `http://x` },
            notes: {},
            pick: { agent: `codex`, model: `gpt-5.6`, effort: `high` },
            stories: [story(`login`)],
        });
        expect(parseManifest(JSON.stringify(source))).toEqual(source);
    });

    it(`rejects a manifest that cannot identify the exact story revision it tested`, () => {
        expect(
            parseManifest(
                `{"runId":"rabc","createdAt":7,"targets":{},"notes":{},"pick":{"agent":"codex","model":"gpt-5.6"},"launchFailures":{},"stories":[{"slug":"login"}]}`,
            ),
        ).toBeUndefined();
    });

    it(`rejects identities that could escape the run or address a different fleet session`, () => {
        const manifest = runManifestOf({
            runId: `rabc`,
            createdAt: 7,
            targets: {},
            notes: {},
            pick: { agent: `codex`, model: `gpt-5.6` },
            stories: [story(`login`)],
        });
        expect(parseManifest(JSON.stringify({ ...manifest, runId: `../outside` }))).toBeUndefined();
        expect(
            parseManifest(JSON.stringify({ ...manifest, stories: [{ ...manifest.stories[0], conversationId: `xt-some-other-run` }] })),
        ).toBeUndefined();
        expect(parseManifest(JSON.stringify({ ...manifest, launchFailures: { unknown: `refused` } }))).toBeUndefined();
    });

    it.each([`not json`, `null`, `{"stories":[]}`, `{"runId":"rabc"}`, `[]`])(`skips %s`, (text) => {
        expect(parseManifest(text)).toBeUndefined();
    });
});

describe(`parseResult`, () => {
    const expected = story(`login`);
    const result = (over: Record<string, unknown> = {}): string =>
        JSON.stringify({
            story: `login`,
            title: `login`,
            verdict: `fail`,
            criteria: [{ text: `login works`, verdict: `fail`, note: `the button did nothing` }],
            steps: [{ n: 1, action: `clicked`, expected: `signed in`, observed: `nothing`, shot: `shots/01-click.png` }],
            defects: [{ severity: `major`, summary: `Cannot sign in`, repro: `Click sign in`, shot: `shots/01-click.png` }],
            ...over,
        });

    it(`accepts complete evidence matching the run's story snapshot`, () => {
        expect(parseResult(result(), expected)?.verdict).toBe(`fail`);
    });

    it(`rejects a bare verdict and criteria that were dropped or paraphrased`, () => {
        expect(parseResult(`{"story":"login","verdict":"pass"}`, expected)).toBeUndefined();
        expect(parseResult(result({ criteria: [{ text: `something else`, verdict: `fail`, note: `no` }] }), expected)).toBeUndefined();
    });

    it(`rejects pass unless every recorded criterion passed`, () => {
        expect(parseResult(result({ verdict: `pass` }), expected)).toBeUndefined();
        expect(
            parseResult(result({ verdict: `pass`, criteria: [{ text: `login works`, verdict: `pass`, note: `worked` }], defects: [] }), expected)
                ?.verdict,
        ).toBe(`pass`);
    });

    it(`rejects evidence paths outside the story's flat shots directory`, () => {
        expect(
            parseResult(
                result({
                    steps: [{ n: 1, action: `clicked`, expected: `signed in`, observed: `nothing`, shot: `../secret.png` }],
                }),
                expected,
            ),
        ).toBeUndefined();
    });

    it.each([`not json`, `{"story":"login"}`, `{"verdict":"probably"}`, `null`])(`treats %s as no result yet rather than a verdict`, (source) => {
        expect(parseResult(source, expected)).toBeUndefined();
    });
});

// Pins the shared label/tone a story's row and a report both read off session status and verdict, so a refused session
// doesn't read as untouched.
describe(`storyStanding`, () => {
    it(`calls a story whose session died untested, in the tone of something to look at`, () => {
        expect(storyStanding(undefined, `error`)).toEqual({ label: `untested`, variant: `danger` });
    });

    it(`keeps a written verdict whatever became of the session afterwards`, () => {
        expect(storyStanding(`pass`, `error`)).toEqual({ label: `pass`, variant: `success` });
        expect(storyStanding(`fail`, `idle`)).toEqual({ label: `fail`, variant: `danger` });
        expect(storyStanding(`blocked`, undefined)).toEqual({ label: `blocked`, variant: `warning` });
    });

    it(`reads a live session as progress`, () => {
        expect(storyStanding(undefined, `running`)).toEqual({ label: `testing`, variant: `info` });
        expect(storyStanding(undefined, `awaiting`)).toEqual({ label: `testing`, variant: `info` });
    });

    it(`says nothing about a story nothing has happened to`, () => {
        expect(storyStanding(undefined, undefined)).toBeUndefined();
        expect(storyStanding(undefined, `idle`)).toBeUndefined();
    });
});
