import { setLocale } from "@intentic/ui/i18n";
import { AgentErrorCodeSchema } from "@intentic/sandbox-contract/events/agent-events";
import { failureDetails, failureView, legacyFailure } from "./failureView";

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

// Every code the wire names, worded by the provider: the line is this build's own, never the words, which are the details.
const PROVIDER_WORDS = `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;

describe(`a failure, as one line`, () => {
    afterAll(async () => {
        await setLocale(`en`);
    });

    it(`leads a provider's words with this build's line for their kind, and keeps the words, all of them, as the details`, () => {
        expect(failureView({ message: FLAGGED_SESSION, error: `safeguard-flagged` })).toEqual({
            line: `The model's safeguards flagged this turn.`,
            said: FLAGGED_SESSION,
            ends: true,
        });
        expect(failureView({ message: `You've hit your usage limit.`, error: `rate_limit` }).line).toBe(`This account's usage limit is reached.`);
    });

    // The class of bug this pins: whatever a runtime coded, the reader's line is never someone else's words (2026-10-06,
    // 10-19, 10-20: raw provider text "fixed" on one path and back on the next).
    it(`never makes a provider's words the line, for any code the wire names`, () => {
        const raw = AgentErrorCodeSchema.options
            .map((code) => ({ code, view: failureView({ message: PROVIDER_WORDS, error: code }) }))
            .filter(({ view }) => view.line.includes(`API Error`) || view.line === `` || view.line.startsWith(`chat.`));
        expect(raw).toEqual([]);
    });

    it(`says the sandbox's own sentence as the line, with nothing behind it`, () => {
        const own = `Free trial unavailable. Failed agent steps are not counted. Retry, or connect a model of your own.`;
        expect(failureView({ message: own, error: `trial-unavailable`, own: true })).toEqual({ line: own, ends: true });
    });

    it(`names a failure nothing coded, or coded by a newer sandbox, as unclassified, its words the details`, () => {
        const unclassified = `The agent stopped on an error this app does not recognize.`;
        expect(failureView({ message: `fetch failed` })).toEqual({ line: unclassified, said: `fetch failed`, ends: true });
        expect(failureView({ message: `Something new.`, error: `some-new-code` }).line).toBe(unclassified);
    });

    it(`ends the turn on every failure but a warning the runtime went on past`, () => {
        expect(AgentErrorCodeSchema.options.filter((code) => !failureView({ message: `Words.`, error: code }).ends)).toEqual([`codex-advisory`]);
    });

    it(`says the line in the reader's language`, async () => {
        await setLocale(`pl`);
        expect(failureView({ message: FLAGGED_SESSION, error: `safeguard-flagged` }).line).toBe(`Zabezpieczenia modelu oznaczyły tę turę.`);
        await setLocale(`en`);
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

describe(`a row written before failures were coded`, () => {
    it(`is the unclassified kind only by a shape no sandbox sentence takes`, () => {
        expect(legacyFailure(FLAGGED_SESSION)?.said).toBe(FLAGGED_SESSION);
        expect(legacyFailure(`Claude Code process exited with code 143. stderr: Ignoring 13 permissions.allow entries`)?.line).toBe(
            `The agent stopped on an error this app does not recognize.`,
        );
        expect(legacyFailure(`Background job started: \`pnpm test\` — it outlives this turn, and its exit wakes this conversation.`)).toBeUndefined();
        expect(
            legacyFailure(
                `Your workspace moved on while this agent waited, its branch was rebased onto your latest 1 commit. Couldn't rebase onto your workspace in intentic: the turn is running from the older base, so its land may need a resolve.`,
            ),
        ).toBeUndefined();
    });
});
