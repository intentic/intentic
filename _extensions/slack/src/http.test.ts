import { unstubbed } from "@intentic/testing";
import type { SlackConnection } from "./client.js";
import {
    challengeOf,
    checkSlackSignature,
    createSlackHttpIntake,
    type ForwardedCall,
    HTTP_ACK_MS,
    readSlackCall,
    SIGNATURE_MAX_AGE_MS,
    SLACK_RETRY_NUM_HEADER,
    SLACK_SIGNATURE_HEADER,
    SLACK_TIMESTAMP_HEADER,
    slackSignature,
} from "./http.js";
import type { SlackBlockActions, SlackEnvelope, SlackEventsBody } from "./listener.js";

// Slack's own worked example of a signed request ("Verifying requests from Slack" in its API docs): the signing secret,
// the timestamp and form body it sent, and the signature it computed for them.
const SLACK_EXAMPLE = {
    secret: "8f742231b10e8888abcd99yyyzzz85a5",
    timestamp: "1531420618",
    body: "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
    signature: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
};

const SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const OTHER_SECRET = "ffeeddccbbaa99887766554433221100";
const NOW = 1_764_201_600_000;
const SECONDS = String(NOW / 1000);

// A mention as Slack delivers it: the `event_callback` wrapping one message, under its delivery id.
const mention = (eventId: string): SlackEventsBody => ({
    type: "event_callback",
    event_id: eventId,
    team_id: "T1",
    event: { type: "message", channel: "C1", user: "U1", text: "<@U0BOT> help", ts: "1755102030.001900" },
});

test("Slack's own example request verifies with its signing secret", () => {
    const sentAt = Number(SLACK_EXAMPLE.timestamp) * 1000;
    expect(slackSignature(SLACK_EXAMPLE.secret, SLACK_EXAMPLE.timestamp, SLACK_EXAMPLE.body)).toBe(SLACK_EXAMPLE.signature);
    expect(checkSlackSignature(SLACK_EXAMPLE.secret, SLACK_EXAMPLE.timestamp, SLACK_EXAMPLE.signature, SLACK_EXAMPLE.body, sentAt)).toBe("ok");
});

test("a signature over another body, with another secret, or missing is refused", () => {
    const body = `{"type":"event_callback"}`;
    const signature = slackSignature(SECRET, SECONDS, body);
    expect(checkSlackSignature(SECRET, SECONDS, signature, `{"type":"event_callback","x":1}`, NOW)).toBe("bad");
    expect(checkSlackSignature(OTHER_SECRET, SECONDS, signature, body, NOW)).toBe("bad");
    expect(checkSlackSignature(SECRET, undefined, signature, body, NOW)).toBe("bad");
    expect(checkSlackSignature(SECRET, SECONDS, undefined, body, NOW)).toBe("bad");
    expect(checkSlackSignature(SECRET, `${SECONDS}.5`, signature, body, NOW)).toBe("bad");
    // A card with no secret vouches for nothing, not even a call "signed" with the empty string.
    expect(checkSlackSignature("", SECONDS, slackSignature("", SECONDS, body), body, NOW)).toBe("bad");
});

test("a genuine request is refused as stale once its timestamp is more than five minutes off, either way", () => {
    const body = `{}`;
    const signedAt = (offsetMs: number): string => String((NOW + offsetMs) / 1000);
    const check = (offsetMs: number) => checkSlackSignature(SECRET, signedAt(offsetMs), slackSignature(SECRET, signedAt(offsetMs), body), body, NOW);
    expect(check(-SIGNATURE_MAX_AGE_MS)).toBe("ok");
    expect(check(-SIGNATURE_MAX_AGE_MS - 1000)).toBe("stale");
    expect(check(SIGNATURE_MAX_AGE_MS)).toBe("ok");
    expect(check(SIGNATURE_MAX_AGE_MS + 1000)).toBe("stale");
});

test("a call is read as Slack names it: the URL check, an event by its id, a button press, or nothing", () => {
    expect(readSlackCall("application/json", `{"type":"url_verification","challenge":"3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P","token":"x"}`)).toEqual({
        kind: "url_verification",
        challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    });
    expect(readSlackCall("application/json", JSON.stringify(mention("Ev1")))).toEqual({ kind: "event", eventId: "Ev1", body: mention("Ev1") });
    const press: SlackBlockActions = { type: "block_actions", user: { id: "U7" }, channel: { id: "C1" }, message: { ts: "9.1" }, actions: [{ action_id: "stop" }] };
    expect(readSlackCall("application/x-www-form-urlencoded", new URLSearchParams({ payload: JSON.stringify(press) }).toString())).toEqual({ kind: "interactive", body: press });
    expect(readSlackCall("application/x-www-form-urlencoded", new URLSearchParams({ payload: `{"type":"view_submission"}` }).toString())).toEqual({ kind: "other" });
    expect(readSlackCall("application/json", `{"type":"app_rate_limited","minute_rate_limited":1}`)).toEqual({ kind: "other" });
    expect(readSlackCall("application/json", `not json`)).toEqual({ kind: "other" });
});

test("only a challenge shaped like Slack's is echoed", () => {
    expect(challengeOf("application/json", `{"type":"url_verification","challenge":"abc_DEF-123"}`)).toBe("abc_DEF-123");
    expect(challengeOf("application/json", `{"type":"url_verification","challenge":"<script>alert(1)</script>"}`)).toBeUndefined();
    expect(challengeOf("application/json", `{"type":"event_callback","challenge":"abc"}`)).toBeUndefined();
});

// A call to the Request URL as the backend hands it on, signed with `secret` at NOW: an event as JSON, a button press
// form-encoded, as Slack sends each.
const signedCall = (text: string, contentType: string, secret: string, headers: Record<string, string>): ForwardedCall => ({
    body: text,
    headers: { "content-type": contentType, [SLACK_TIMESTAMP_HEADER]: SECONDS, [SLACK_SIGNATURE_HEADER]: slackSignature(secret, SECONDS, text), ...headers },
});
const signed = (body: object, secret = SECRET, headers: Record<string, string> = {}): ForwardedCall => signedCall(JSON.stringify(body), "application/json", secret, headers);
const signedForm = (press: SlackBlockActions): ForwardedCall =>
    signedCall(new URLSearchParams({ payload: JSON.stringify(press) }).toString(), "application/x-www-form-urlencoded", SECRET, {});


interface IntakeOptions {
    // The cards whose connection is open (both, when absent).
    readonly open?: readonly string[];
    // Whether an enabled Slack automation wants them open (yes, when absent).
    readonly automations?: boolean;
    // Whether the gateway has read its cards yet (yes, when absent).
    readonly loaded?: boolean;
    readonly ack?: boolean;
    readonly ackWithinMs?: number;
}

// The intake over two cards, "a" and "b"; every envelope it hands the listener is kept, and acked at once unless `ack`
// is false.
const intakeOf = (options: IntakeOptions = {}) => {
    const delivered: Array<{ readonly to: string; readonly envelope: SlackEnvelope }> = [];
    const connections = new Map((options.open ?? ["a", "b"]).map((id) => [id, unstubbed<SlackConnection>("connection", { id })]));
    const apps = [
        { id: "a", signingSecret: SECRET },
        { id: "b", signingSecret: OTHER_SECRET },
    ];
    const intake = createSlackHttpIntake({
        apps: () => (options.loaded === false ? undefined : apps),
        connection: (id) => connections.get(id),
        listening: async () => options.automations ?? true,
        deliver: (connection, envelope) => {
            delivered.push({ to: connection.id, envelope });
            if (options.ack !== false) {
                void envelope.ack();
            }
        },
        log: { info: () => {}, warn: () => {}, error: () => {} },
        now: () => NOW,
        ackWithinMs: options.ackWithinMs ?? HTTP_ACK_MS,
    });
    return { intake, delivered, connections };
};

test("a signed event reaches the listener as the events_api envelope Socket Mode delivers, for the app that signed it", async () => {
    const { intake, delivered } = intakeOf();
    expect(await intake.receive(signed(mention("Ev1"), OTHER_SECRET))).toEqual({ status: 200, body: "" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toBe("b");
    expect(delivered[0]?.envelope).toMatchObject({ type: "events_api", body: mention("Ev1") });
});

test("the answer waits for the envelope's ack, and goes by the deadline when the ack never comes", async () => {
    const { intake, delivered } = intakeOf({ ack: false, ackWithinMs: 30 });
    let answered = false;
    const answer = intake.receive(signed(mention("Ev1"))).then((result) => {
        answered = true;
        return result;
    });
    await Promise.resolve();
    expect(delivered).toHaveLength(1);
    expect(answered).toBe(false);
    expect(await answer).toEqual({ status: 200, body: "" });

    const prompt = intakeOf({ ack: false, ackWithinMs: 60_000 });
    const quick = prompt.intake.receive(signed(mention("Ev2")));
    await Promise.resolve();
    await prompt.delivered[0]?.envelope.ack();
    expect(await quick).toEqual({ status: 200, body: "" });
});

test("Slack's retry of an event already taken is acked and handed to no one", async () => {
    const { intake, delivered } = intakeOf();
    await intake.receive(signed(mention("Ev1")));
    expect(await intake.receive(signed(mention("Ev1"), SECRET, { [SLACK_RETRY_NUM_HEADER]: "1" }))).toEqual({ status: 200, body: "" });
    expect(delivered).toHaveLength(1);
    // A retry is the first this process hears of an event that arrived while the sandbox slept: that one goes through.
    await intake.receive(signed(mention("Ev2"), SECRET, { [SLACK_RETRY_NUM_HEADER]: "1" }));
    expect(delivered.map(({ envelope }) => envelope.body)).toEqual([mention("Ev1"), mention("Ev2")]);
});

test("a call no card's secret signed, or signed too long ago, is refused and reaches nothing", async () => {
    const { intake, delivered } = intakeOf();
    expect(await intake.receive(signed(mention("Ev1"), "someone-elses-secret-0123456789ab"))).toEqual({ status: 401, body: "bad signature" });
    const old = String((NOW - SIGNATURE_MAX_AGE_MS - 60_000) / 1000);
    const body = JSON.stringify(mention("Ev2"));
    const replayed: ForwardedCall = {
        body,
        headers: { "content-type": "application/json", [SLACK_TIMESTAMP_HEADER]: old, [SLACK_SIGNATURE_HEADER]: slackSignature(SECRET, old, body) },
    };
    expect(await intake.receive(replayed)).toEqual({ status: 401, body: "stale request" });
    expect(delivered).toEqual([]);
});

test("a call signed by a card nothing listens on (no Slack automation on) is acked, so Slack never reads the silence as a broken URL", async () => {
    const { intake, delivered } = intakeOf({ open: ["b"], automations: false });
    expect(await intake.receive(signed(mention("Ev1")))).toEqual({ status: 200, body: "" });
    expect(delivered).toEqual([]);
});

test("a call that arrives while the card's connection is still opening, as right after a wake, is refused for Slack to send again", async () => {
    const { intake, delivered, connections } = intakeOf({ open: ["b"] });
    expect(await intake.receive(signed(mention("Ev1")))).toEqual({ status: 503, body: "the Slack connection is starting" });
    expect(delivered).toEqual([]);
    // Slack's retry, once the connection is open, is taken: the refusal did not count the event as taken.
    connections.set("a", unstubbed<SlackConnection>("connection", { id: "a" }));
    expect(await intake.receive(signed(mention("Ev1"), SECRET, { [SLACK_RETRY_NUM_HEADER]: "1" }))).toEqual({ status: 200, body: "" });
    expect(delivered.map(({ to }) => to)).toEqual(["a"]);
});

test("a call before the gateway has read its cards is refused for Slack to send again, not as a bad signature", async () => {
    const { intake, delivered } = intakeOf({ loaded: false });
    expect(await intake.receive(signed(mention("Ev1")))).toEqual({ status: 503, body: "the Slack connection is starting" });
    expect(delivered).toEqual([]);
});

test("the URL check is answered with its challenge whether or not a card holds the app's secret yet", async () => {
    const { intake, delivered } = intakeOf();
    expect(await intake.receive({ headers: { "content-type": "application/json" }, body: `{"type":"url_verification","challenge":"c0ffee"}` })).toEqual({
        status: 200,
        body: "c0ffee",
    });
    expect(delivered).toEqual([]);
});

test("a button press reaches the listener as Socket Mode's interactive envelope", async () => {
    const { intake, delivered } = intakeOf();
    const press: SlackBlockActions = { type: "block_actions", user: { id: "U7" }, channel: { id: "C1" }, message: { ts: "9.1" }, actions: [{ action_id: "stop" }] };
    expect(await intake.receive(signedForm(press))).toEqual({ status: 200, body: "" });
    expect(delivered).toEqual([{ to: "a", envelope: { type: "interactive", body: press, ack: expect.any(Function) } }]);
});
