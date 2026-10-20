import { failureDetails } from "./failureDetails";

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
