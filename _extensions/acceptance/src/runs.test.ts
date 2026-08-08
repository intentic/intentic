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

// The daemon's own guard on AgentTurn.conversationId — it lands in branch names (agent/<id>) and filesystem
// paths, so a violation is not a validation error the UI can retry past.
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

    // The slug is what gets cut when the two would overflow, never the run id — an id truncated past its run is
    // an agent nothing can attribute.
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
        provider: `claude`,
        model: `claude-sonnet-4-5`,
        stories: [story(`login`, `app`, `site`), story(`checkout`, `api`)],
    });

    // The group rides along because it is half of the key the brief's baseUrl is looked up by (targetKeyOf), so a
    // manifest that dropped it could not say which server its own story was walked against.
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

    // A run spans repos AND apps within one repo, so a single baseUrl could only ever describe one of them.
    it(`keeps one address per story group`, () => {
        expect(manifest.targets).toEqual({ "app/site": `http://localhost:4321`, api: `http://localhost:3000` });
    });

    it(`omits an unset model instead of writing an empty string`, () => {
        const withoutModel = runManifestOf({ ...manifest, model: ``, stories: [story(`login`)] });
        expect(`model` in withoutModel).toBe(false);
    });
});

describe(`reposOf`, () => {
    it(`lists every repo a run touched once, in first-appearance order`, () => {
        const manifest = runManifestOf({
            runId: `rabc`,
            createdAt: 0,
            targets: {},
            notes: {},
            provider: `claude`,
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
    it(`sits under .intentic, outside every repo — no git noise, nothing to land`, () => {
        expect(storyDir(`rabc`, `login`)).toBe(`.intentic/artifacts/acceptance/rabc/login`);
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

/* One unreadable run directory must never blank the list — the runs view and the rail badge both walk every
 * directory they find, and a half-written run.json is an ordinary sight while a run is starting. */
describe(`parseManifest`, () => {
    it(`reads a manifest back`, () => {
        const source = runManifestOf({
            runId: `rabc`,
            createdAt: 7,
            targets: { app: `http://x` },
            notes: {},
            provider: `codex`,
            stories: [story(`login`)],
        });
        expect(parseManifest(JSON.stringify(source))).toEqual(source);
    });

    it(`rejects a manifest that cannot identify the exact story revision it tested`, () => {
        expect(
            parseManifest(
                `{"runId":"rabc","createdAt":7,"targets":{},"notes":{},"provider":"codex","launchFailures":{},"stories":[{"slug":"login"}]}`,
            ),
        ).toBeUndefined();
    });

    it(`rejects identities that could escape the run or address a different fleet session`, () => {
        const manifest = runManifestOf({
            runId: `rabc`,
            createdAt: 7,
            targets: {},
            notes: {},
            provider: `codex`,
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

/* WHAT A STORY'S ROW SAYS, and the case both surfaces used to get wrong. A test session refused on its first
 * request writes nothing at all — no verdict, no report, no screenshot — so the standing is the only thing
 * either surface can show for it, and both showed the story as though nothing had been attempted: the list left
 * it blank, the report called it neutral. A run whose every session died then read as a run nobody had started. */
describe(`storyStanding`, () => {
    it(`calls a story whose session died untested, in the tone of something to look at`, () => {
        expect(storyStanding(undefined, `error`)).toEqual({ label: `untested`, variant: `danger` });
    });

    it(`keeps a written verdict whatever became of the session afterwards`, () => {
        // The agent judged the story and its session then failed — on the report it was writing, on a later
        // turn, on anything. The judgement stands: it is the thing the run exists to produce.
        expect(storyStanding(`pass`, `error`)).toEqual({ label: `pass`, variant: `success` });
        expect(storyStanding(`fail`, `idle`)).toEqual({ label: `fail`, variant: `danger` });
        // `blocked` stays warning, not danger — the app was unreachable, which is not this story being broken.
        expect(storyStanding(`blocked`, undefined)).toEqual({ label: `blocked`, variant: `warning` });
    });

    it(`reads a live session as progress`, () => {
        expect(storyStanding(undefined, `running`)).toEqual({ label: `testing`, variant: `info` });
        expect(storyStanding(undefined, `awaiting`)).toEqual({ label: `testing`, variant: `info` });
    });

    it(`says nothing about a story nothing has happened to`, () => {
        expect(storyStanding(undefined, undefined)).toBeUndefined();
        // A settled session that wrote no verdict is the run's own business (the report says how far it got);
        // in a stories list it is not a standing, and inventing one would age into a permanent stale label.
        expect(storyStanding(undefined, `idle`)).toBeUndefined();
    });
});
