import { setLocale } from "@intentic/ui/i18n";
import { failureDetails, failureHeadline, looksLikeProviderFailure } from "./providerFailure";

// Each message here is one a sandbox in use actually wrote into a transcript, as it wrote it.

// The Claude CLI's safeguard flag, paragraphs and all.
const FLAGGED_SESSION = [
    `API Error: Opus 5.5's safeguards flagged this session (https://www.anthropic.com/legal/aup). You may be seeing this for the first time: Opus 5.5 is more capable and has stronger safeguards as a result, which can sometimes flag non-cybersecurity work. We're improving these safeguards to reduce the amount of incorrectly flagged messages. Claude Code can't respond to your last message with Opus 5.5.`,
    `Try rephrasing the request in a new session or change your model.`,
    `Learn more: https://support.claude.com/en/articles/8106465`,
    "Details: `[cyber]`",
    `Request ID: req_011CfmGgktqWtwzpffP3NhAk`,
    `Message ID: msg_011CfmGgmnQdSfvKck2zDhPr`,
].join(`\n\n`);

// The same flag as an older SDK result wrapped it, with a category of two words and no message id.
const FLAGGED_MESSAGE = [
    `Claude Code returned an error result: API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.`,
    `Try rephrasing the request in a new session or change your model.`,
    `Learn more: https://support.claude.com/en/articles/15363606`,
    "Details: `[reasoning_extraction]`",
    `Request ID: req_011Cdxi49tXuS7KEBq4dzSBc`,
].join(`\n\n`);

describe(`a provider's failure, as one line`, () => {
    afterAll(async () => {
        await setLocale(`en`);
    });

    it(`names a safeguard flag in this build's words, with the model the CLI named`, () => {
        expect(failureHeadline(FLAGGED_SESSION, `safeguard-flagged`)).toBe(`Opus 5.5's safeguards flagged this session.`);
        // An uncoded row from an older sandbox reads the same: the words say which failure it is.
        expect(failureHeadline(FLAGGED_MESSAGE)).toBe(`Fable 5's safeguards flagged this message.`);
    });

    it(`names a coded safeguard flag even when the CLI words it some other way`, () => {
        expect(failureHeadline(`${`The response was stopped. `.repeat(10)}`, `safeguard-flagged`)).toBe(`The model's safeguards flagged this turn.`);
    });

    it(`says a safeguard flag in the reader's language`, async () => {
        await setLocale(`pl`);
        expect(failureHeadline(FLAGGED_SESSION, `safeguard-flagged`)).toBe(`Zabezpieczenia modelu Opus 5.5 oznaczyły tę sesję.`);
        await setLocale(`en`);
    });

    it(`leaves a short message on one line as its own line`, () => {
        expect(failureHeadline(`Anthropic is down.`)).toBeUndefined();
        expect(failureHeadline(`API Error: 400 Claude Code 2.1.233 does not support this model; version 2.1.251 or newer is required.`)).toBeUndefined();
    });

    it(`keeps the first thing the provider said, after the wrappers in front of it`, () => {
        expect(
            failureHeadline(
                `API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.`,
            ),
        ).toBe(`Internal server error.`);
        // The CLI's guess in front of the provider's words is not what the provider said.
        expect(
            failureHeadline(
                `Failed to authenticate. API Error: 403 You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota`,
            ),
        ).toBe(`You've reached your weekly (7-day) usage limit.`);
    });

    it(`drops an aside, a body cut off mid-way, and a dump after a colon`, () => {
        expect(
            failureHeadline(
                `unexpected status 503 Service Unavailable: auth_unavailable: no auth available (providers=codex, model=gpt-6-astra; last upstream error: Post "https://chatgpt.com/backend-api/codex/responses": i/o timeout), url: http://127.0.0.1:8789/v1/responses`,
            ),
        ).toBe(`unexpected status 503 Service Unavailable: auth_unavailable: no auth available.`);
        expect(
            failureHeadline(
                `auth_unavailable: no auth available (providers=antigravity, model=claude-opus-4-6-thinking; last upstream error: {\n  "error": {\n    "code": 503,\n    "message": "No capacity available"\n  }\n})`,
            ),
        ).toBe(`auth_unavailable: no auth available.`);
        expect(
            failureHeadline(
                `Codex app-server closed its output: file:///history/engines/codex/versions/0.160.1/node_modules/@openai/codex/bin/codex.js:107\n  throw new Error(\n        ^`,
            ),
        ).toBe(`Codex app-server closed its output.`);
    });

    it(`reads a routed provider's JSON body for the sentence it carries`, () => {
        expect(failureHeadline(`API Error: 404 {"error":{"code":"model_not_found","message":"The model \\"gpt-9\\" does not exist."}}\n\nCheck the model.`)).toBe(
            `The model "gpt-9" does not exist.`,
        );
    });

    it(`cuts a sentence that never stops at a word`, () => {
        const line = failureHeadline(`word `.repeat(80).trim())!;
        expect(line.length).toBeLessThanOrEqual(200);
        expect(line.endsWith(`word…`)).toBe(true);
    });
});

describe(`a provider's failure, in full`, () => {
    it(`pulls the category, the ids and the help article out of the prose, and keeps every paragraph of the rest`, () => {
        const details = failureDetails(FLAGGED_SESSION);
        expect(details.facts).toEqual([
            { key: `category`, value: `cyber` },
            { key: `request`, value: `req_011CfmGgktqWtwzpffP3NhAk` },
            { key: `message`, value: `msg_011CfmGgmnQdSfvKck2zDhPr` },
        ]);
        expect(details.learnMore).toBe(`https://support.claude.com/en/articles/8106465`);
        const prose = details.prose.map((run) => (`url` in run ? `<${run.label}>` : run.text)).join(``);
        expect(prose).toBe(
            `API Error: Opus 5.5's safeguards flagged this session (<anthropic.com/legal/aup>). You may be seeing this for the first time: Opus 5.5 is more capable and has stronger safeguards as a result, which can sometimes flag non-cybersecurity work. We're improving these safeguards to reduce the amount of incorrectly flagged messages. Claude Code can't respond to your last message with Opus 5.5.\n\nTry rephrasing the request in a new session or change your model.`,
        );
        expect(details.prose.find((run) => `url` in run)).toEqual({ url: `https://www.anthropic.com/legal/aup`, label: `anthropic.com/legal/aup` });
    });

    it(`reads the facts off a flag a CLI ran together on one line, and says a category in words`, () => {
        const details = failureDetails(FLAGGED_MESSAGE.replaceAll(`\n\n`, ` `));
        expect(details.facts).toEqual([
            { key: `category`, value: `reasoning extraction` },
            { key: `request`, value: `req_011Cdxi49tXuS7KEBq4dzSBc` },
        ]);
        expect(details.prose.map((run) => (`url` in run ? run.label : run.text)).join(``)).toMatch(/change your model\.$/);
    });

    it(`keeps a link's closing full stop out of its address`, () => {
        const { prose } = failureDetails(`Server error. If it persists, check https://status.claude.com.`);
        expect(prose).toEqual([{ text: `Server error. If it persists, check ` }, { url: `https://status.claude.com`, label: `status.claude.com` }, { text: `.` }]);
    });
});

describe(`a row with no code`, () => {
    it(`is a provider's failure only by a shape no sandbox sentence takes`, () => {
        expect(looksLikeProviderFailure(FLAGGED_SESSION)).toBe(true);
        expect(looksLikeProviderFailure(`Claude Code process exited with code 143. stderr: Ignoring 13 permissions.allow entries`)).toBe(true);
        expect(looksLikeProviderFailure(`Background job started: \`pnpm test\` — it outlives this turn, and its exit wakes this conversation.`)).toBe(false);
        expect(
            looksLikeProviderFailure(
                `Your workspace moved on while this agent waited, its branch was rebased onto your latest 1 commit. Couldn't rebase onto your workspace in intentic: the turn is running from the older base, so its land may need a resolve.`,
            ),
        ).toBe(false);
    });
});
