import { IN_MEMORY, type SqliteDb } from "@intentic/base/sqlite";
import { TURN_PREAMBLE_SEPARATOR } from "@intentic/constants";
import { openRecallDb } from "../store/db.js";
import { matchSessions } from "./match.js";

// A corpus seeded row by row, so every term's document frequency is known: each of alpha, bravo, charlie, delta, echo and
// juliet sits in exactly one turn, which gives them equal IDF weight and makes coverage a plain share of the prompt's terms.
const HOUR_MS = 60 * 60 * 1000;

let db: SqliteDb;

const seed = (sessionId: string, title: string | null, prompts: readonly string[]): void => {
    const ts = Date.now() - HOUR_MS;
    db.run(
        "INSERT INTO sessions (session_id, slug, title, version, git_branch, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        sessionId,
        "proj",
        title,
        "1",
        "main",
        ts,
        ts,
    );
    const sessionRowId = Number(db.get("SELECT id FROM sessions WHERE session_id = ?", sessionId)!["id"]);
    prompts.forEach((prompt, ordinal) =>
        db.run(
            "INSERT INTO turns (session_id, uuid, ordinal, ts, prompt, response, start_byte) VALUES (?, ?, ?, ?, ?, '', 0)",
            sessionRowId,
            `${sessionId}-u${ordinal}`,
            ordinal,
            ts,
            prompt,
        ),
    );
};

// Each content-free prompt below is also stored verbatim, the corpus a busy workspace has: under the old gate their raw
// BM25 against their own repeat made every one of them a strong match.
const CONTENT_FREE = ["can you help me with this", "please make it better and push", "continue", "thanks, now push", "fix it", "ok go ahead"];

// The daemon's project map as it opens a prompt, and the same words as a session once quoted them: the preamble every
// prompt in a sandbox carries, so left in, it made any two of them look alike.
const MAP_TEXT = "The workspace, four areas: sandbox, editor, extensions.";
const wrapped = (prompt: string): string => `## Map of this project\n\n${MAP_TEXT}${TURN_PREAMBLE_SEPARATOR}${prompt}`;

beforeAll(() => {
    db = openRecallDb(IN_MEMORY);
    CONTENT_FREE.forEach((prompt, index) => seed(`chatter-${index}`, null, [prompt, "ok go ahead and continue"]));
    seed("topic", null, ["wire the alpha bravo exporter", "juliet exporter follow-up"]);
    seed("decoy-cd", null, ["charlie delta"]);
    seed("decoy-e", null, ["echo"]);
    seed("titled", "Lima rollout", ["kilo notes"]);
    seed("mapped", null, [MAP_TEXT]);
});
afterAll(() => {
    db.close();
});

test.each(CONTENT_FREE)("a content-free prompt is never strong, even against its own verbatim repeat: %s", (prompt) => {
    expect(matchSessions(db, prompt).filter((match) => match.strong)).toEqual([]);
});

test("a prompt left with one content term is not strong even at full coverage", () => {
    // "push" is the only content term of "please make it better and push"; both sessions that said it cover it fully,
    // the shorter "thanks, now push" ranking first on BM25's length normalisation.
    const matches = matchSessions(db, "please make it better and push");
    expect(matches.map((match) => [match.sessionId, match.coverage, match.strong])).toEqual([
        ["chatter-3", 1, false],
        ["chatter-1", 1, false],
    ]);
});

test("two content terms, both covered, is strong: the MIN_CONTENT_TERMS edge", () => {
    const top = matchSessions(db, "alpha bravo")[0];
    expect([top?.sessionId, top?.coverage, top?.strong]).toEqual(["topic", 1, true]);
});

test("covering exactly half of the prompt's content-term weight is strong", () => {
    // alpha, bravo in `topic`; charlie, delta in `decoy-cd`: 2 of 4 equal weights.
    const topic = matchSessions(db, "alpha bravo charlie delta").find((match) => match.sessionId === "topic");
    expect([topic?.coverage, topic?.strong]).toEqual([0.5, true]);
});

test("one term short of half is not strong", () => {
    // echo sits in `decoy-e`: 2 of 5 equal weights.
    const topic = matchSessions(db, "alpha bravo charlie delta echo").find((match) => match.sessionId === "topic");
    expect(topic?.coverage).toBeCloseTo(2 / 5, 12);
    expect(topic?.strong).toBe(false);
});

test("coverage is judged within one turn: terms spread over two turns of a session do not add up", () => {
    // alpha in turn 0, juliet in turn 1, charlie in `decoy-cd`: summed over turns that would be 2 of 3.
    const topic = matchSessions(db, "alpha juliet charlie").find((match) => match.sessionId === "topic");
    expect(topic?.coverage).toBeCloseTo(1 / 3, 12);
    expect(topic?.strong).toBe(false);
});

test("the title counts with the best turn: a term only the title carries completes coverage", () => {
    const titled = matchSessions(db, "kilo lima").find((match) => match.sessionId === "titled");
    expect(titled?.coverage).toBeCloseTo(1, 12);
    expect(titled?.strong).toBe(true);
});

test("a prompt of nothing but stopwords and filler builds no query and matches nothing", () => {
    expect(matchSessions(db, "can you please help me with this now")).toEqual([]);
});

test("the map's own words match the session that quoted them strongly: what a preamble used to add to every prompt", () => {
    const top = matchSessions(db, MAP_TEXT)[0];
    expect([top?.sessionId, top?.coverage, top?.strong]).toEqual(["mapped", 1, true]);
});

test.each(CONTENT_FREE)("a content-free prompt behind the daemon's preamble is not strong: %s", (prompt) => {
    expect(matchSessions(db, wrapped(prompt)).filter((match) => match.strong)).toEqual([]);
});

test("a topical prompt behind the preamble matches exactly what it matches bare", () => {
    const summary = (prompt: string): unknown[] => matchSessions(db, prompt).map((match) => [match.sessionId, match.coverage, match.strong]);
    expect(summary(wrapped("alpha bravo"))).toEqual([["topic", 1, true]]);
    expect(summary(wrapped("alpha bravo"))).toEqual(summary("alpha bravo"));
});
