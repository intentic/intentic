import { setLocale } from "@intentic/ui/i18n";
import { AgentErrorCodeSchema } from "@intentic/sandbox-contract/events/agent-events";
import { failureView, legacyFailure } from "./failureView";

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

    it(`names a failure coded by a newer sandbox, or one whose words say nothing, as unclassified, its words the details`, () => {
        const unclassified = `The agent stopped on an error this app does not recognize.`;
        expect(failureView({ message: `Something new.`, error: `some-new-code` }).line).toBe(unclassified);
        expect(failureView({ message: `401.` })).toEqual({ line: unclassified, said: `401.`, ends: true });
        expect(failureView({ message: `API Error: 500 {"type":"error"}` }).line).toBe(unclassified);
    });

    // A failure nothing coded was drawn only as unrecognized, a spent allowance, a revoked sign-in, a safeguard flag and the
    // sandbox's own instruction among them, on the chat's row and the board's card alike (2026-10-21).
    it(`says what a failure nothing coded says: the sandbox's sentence whole, a provider's first claim, a flag as one`, () => {
        const cursor = `Invalid API key. Connect your Cursor account again in Sandbox ▸ Agent.`;
        expect(failureView({ message: cursor })).toEqual({ line: cursor, ends: true });
        expect(failureView({ message: `fetch failed` })).toEqual({ line: `fetch failed`, ends: true });
        const kimi = `Failed to authenticate. API Error: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota`;
        expect(failureView({ message: kimi })).toEqual({ line: `You've reached your 5-hour usage limit.`, said: kimi, ends: true });
        expect(failureView({ message: `Claude Code process exited with code 1. stderr: TypeError: x\n    at Ab1 (file:///opt/claude/cli.js:429:17)` }).line).toBe(
            `Claude Code process exited with code 1.`,
        );
        expect(failureView({ message: FLAGGED_SESSION })).toEqual({ line: `The model's safeguards flagged this turn.`, said: FLAGGED_SESSION, ends: true });
    });

    // A warning the runtime went on past said "The agent finished with a warning." over a turn still working (2026-10-21).
    it(`says a warning the runtime went on past in its own words`, () => {
        const said = `Codex moved this turn from gpt-5.5 to gpt-5.4 because it read as high-risk security work.`;
        expect(failureView({ message: said, error: `codex-advisory` })).toEqual({ line: said, ends: false });
        const fallback = "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
        expect(failureView({ message: fallback, error: `codex-advisory` })).toEqual({
            line: "Model metadata for `gpt-5.6-sol` not found.",
            said: fallback,
            ends: false,
        });
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

describe(`a row written before failures were coded`, () => {
    it(`is a failure only by a shape no sandbox sentence takes, and says what it says`, () => {
        expect(legacyFailure(FLAGGED_SESSION)).toEqual({ line: `The model's safeguards flagged this turn.`, said: FLAGGED_SESSION, ends: true });
        expect(legacyFailure(`Claude Code process exited with code 143. stderr: Ignoring 13 permissions.allow entries`)?.line).toBe(
            `Claude Code process exited with code 143.`,
        );
        expect(legacyFailure(`Background job started: \`pnpm test\` — it outlives this turn, and its exit wakes this conversation.`)).toBeUndefined();
        expect(
            legacyFailure(
                `Your workspace moved on while this agent waited, its branch was rebased onto your latest 1 commit. Couldn't rebase onto your workspace in intentic: the turn is running from the older base, so its land may need a resolve.`,
            ),
        ).toBeUndefined();
    });
});

// THE RULE FOR A CODED ROW WRITTEN BEFORE `own` WAS KEPT (before 2026-10-20): authorship is never inferred, from the code
// or from the words, since the same code is the sandbox's sentence on one path and a provider's on another (Cursor's
// `agent-busy`, a door's `privacy-unshielded`). Such a row reads as the provider's: its kind's line, which every code has
// (KINDS_BY_CODE), and its words, the sandbox's included, one press away. Never the unrecognized line, never a raw
// headline, and nothing it said is lost.
describe(`a coded row written before authorship was kept`, () => {
    const SAID = `The protected execution-domain policy is unreadable: refused before any model ran.`;

    // A warning the runtime went on past is the one code whose words are its line, whoever wrote them.
    it(`leads with its kind's line and keeps its sentence as the details, for every code the wire names but a warning`, () => {
        const unrecognized = `The agent stopped on an error this app does not recognize.`;
        const read = AgentErrorCodeSchema.options.filter((code) => code !== `codex-advisory`).map((code) => failureView({ message: SAID, error: code }));
        expect(read.filter((view) => view.line === unrecognized || view.line === SAID)).toEqual([]);
        expect(read.filter((view) => view.said !== undefined && view.said !== SAID)).toEqual([]);
    });

    it(`reads a door's refusal by what the door held back`, () => {
        expect(failureView({ message: SAID, error: `agent-domain-refused` })).toEqual({ line: `The sandbox held this turn back.`, said: SAID, ends: true });
        expect(failureView({ message: SAID, error: `privacy-unshielded` }).line).toBe(`The privacy shield held this turn back before anything was sent.`);
        expect(failureView({ message: SAID, error: `privacy-instructions` }).line).toBe(`The privacy shield held this turn back before anything was sent.`);
    });
});
