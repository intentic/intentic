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

// THE RULE FOR A CODED ROW WRITTEN BEFORE `own` WAS KEPT (before 2026-10-20): authorship is never inferred, from the code
// or from the words, since the same code is the sandbox's sentence on one path and a provider's on another (Cursor's
// `agent-busy`, a door's `privacy-unshielded`). Such a row reads as the provider's: its kind's line, which every code has
// (KINDS_BY_CODE), and its words, the sandbox's included, one press away. Never the unrecognized line, never a raw
// headline, and nothing it said is lost.
describe(`a coded row written before authorship was kept`, () => {
    const SAID = `The protected execution-domain policy is unreadable: refused before any model ran.`;

    it(`leads with its kind's line and keeps its sentence as the details, for every code the wire names`, () => {
        const unrecognized = `The agent stopped on an error this app does not recognize.`;
        const read = AgentErrorCodeSchema.options.map((code) => failureView({ message: SAID, error: code }));
        expect(read.filter((view) => view.line === unrecognized || view.line === SAID)).toEqual([]);
        expect(read.filter((view) => view.said !== undefined && view.said !== SAID)).toEqual([]);
    });

    it(`reads a door's refusal by what the door held back`, () => {
        expect(failureView({ message: SAID, error: `agent-domain-refused` })).toEqual({ line: `The sandbox held this turn back.`, said: SAID, ends: true });
        expect(failureView({ message: SAID, error: `privacy-unshielded` }).line).toBe(`The privacy shield held this turn back before anything was sent.`);
        expect(failureView({ message: SAID, error: `privacy-instructions` }).line).toBe(`The privacy shield held this turn back before anything was sent.`);
    });
});
