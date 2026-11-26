import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account } from "./accounts.js";
import { type Action, actionFor, digestOf, executeAction, freeze, heldStore, performHeld, type Verdict } from "./actions.js";
import { Graph } from "./graph.js";
import { account, fakeOutward, httpQueue, type MockAnswer } from "./testing.js";

// The owner's rule on an action is the daemon's (stood in for by fakeOutward): this carries out what it allows, refuses
// what it denies with its reason, and freezes what it holds, which only `performHeld` (the approvals executor's door,
// reached after a person's yes) sends, and only while the frozen request still hashes to what was approved.

const draft = {
    key: "microsoft365.mail.send" as const,
    path: "/me/sendMail",
    method: "POST" as const,
    body: { message: { subject: "Wniosek", body: { content: "Treść" } } },
    summary: 'Send "Wniosek" — to someone',
    details: "To: someone",
    channel: "someone@example.org",
};

let dir = "";
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "m365-held-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const always =
    (verdict: Verdict) =>
    (): Verdict =>
        verdict;

const act = async (verdict: Verdict, answers: MockAnswer[] = [{ status: 202 }], who: Account = account) => {
    const mock = httpQueue(answers);
    const door = fakeOutward(always(verdict));
    const graph = new Graph(who, async () => "access", mock.http);
    const action = actionFor(who, draft);
    const outcome = executeAction({ graph, outward: door.outward, held: heldStore(dir), conversationId: "conv-1" }, action);
    return { outcome, calls: mock.calls, door, action };
};

test("an allowed send goes to Graph once and is recorded; nothing stays held", async () => {
    const { outcome, calls, door, action } = await act({ verdict: "allow" });
    expect(await outcome).toEqual({ held: false, result: undefined });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe("/v1.0/me/sendMail");
    expect(door.asks).toEqual([
        {
            id: "office",
            action: "mail.send",
            endpoint: "/me/sendMail",
            content: "To: someone",
            channel: "someone@example.org",
            conversationId: "conv-1",
            hold: { summary: draft.summary, details: draft.details, digest: freeze(action).digest },
        },
    ]);
    expect(door.outcomes).toEqual([{ id: "office", action: "mail.send", endpoint: "/me/sendMail", content: "To: someone", channel: "someone@example.org", conversationId: "conv-1", outcome: "ok" }]);
    expect(await readdir(dir)).toEqual([]);
});

test("a denied send is refused with the rule's reason, and Graph is never asked", async () => {
    const { outcome, calls, door } = await act({ verdict: "deny", reason: "microsoft365 mail.send is refused by the action rules" });
    await expect(outcome).rejects.toThrow("microsoft365 mail.send is refused by the action rules");
    expect(calls).toEqual([]);
    expect(door.outcomes).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
});

test("a held send stays frozen under its digest, for the approval the daemon drafted, and Graph is never asked", async () => {
    const { outcome, calls, action } = await act({ verdict: "hold", reason: "requires owner approval", approvalId: "microsoft365-1" });
    expect(await outcome).toEqual({ held: true, approvalId: "microsoft365-1" });
    expect(calls).toEqual([]);
    const { digest, text } = freeze(action);
    expect(await readdir(dir)).toEqual([`${digest}.json`]);
    expect(await readFile(join(dir, `${digest}.json`), "utf8")).toBe(text);
    expect((await stat(join(dir, `${digest}.json`))).mode & 0o777).toBe(0o600);
});

test("read only refuses before the rules are even asked", async () => {
    const { outcome, door } = await act({ verdict: "allow" }, [], { ...account, access: "read" });
    await expect(outcome).rejects.toThrow("read-only");
    expect(door.asks).toEqual([]);
});

// A held action as the backend left it, and the card as the daemon holds it at perform time.
const hold = async (): Promise<{ readonly action: Action; readonly digest: string }> => {
    const { outcome, action } = await act({ verdict: "hold", reason: "held", approvalId: "microsoft365-1" });
    await outcome;
    return { action, digest: freeze(action).digest };
};

const perform = async (digest: string, verdict: Verdict, answers: MockAnswer[], card: { readonly now: Account | undefined } = { now: account }) => {
    const mock = httpQueue(answers);
    const door = fakeOutward(always(verdict));
    const outcome = await performHeld(
        { outward: door.outward, held: heldStore(dir), account: async () => card.now, graphFor: (who) => new Graph(who, async () => "access", mock.http) },
        digest,
    );
    return { outcome, calls: mock.calls, door };
};

test("an approved action goes out once, as frozen, then is no longer held", async () => {
    const { digest } = await hold();
    const sent = await perform(digest, { verdict: "hold", reason: "held, and now approved" }, [{ status: 202 }]);
    expect(sent.outcome).toEqual({ outcome: "done", result: "Microsoft accepted it" });
    expect(sent.calls).toHaveLength(1);
    expect(JSON.parse(String(sent.calls[0]!.init?.body))).toEqual(draft.body);
    // Asked again without a draft: a deny since the yes would still refuse, a hold is only answered.
    expect(sent.door.asks).toEqual([{ id: "office", action: "mail.send", endpoint: "/me/sendMail", content: "To: someone", channel: "someone@example.org" }]);
    expect(sent.door.outcomes.map((row) => row.outcome)).toEqual(["ok"]);
    expect(await readdir(dir)).toEqual([]);
    expect((await perform(digest, { verdict: "allow" }, [])).outcome).toMatchObject({ outcome: "refused", error: expect.stringContaining("holds no request") });
});

test("a frozen request edited after the yes, a rule that now denies, or a card that signs in elsewhere refuses it", async () => {
    const { digest } = await hold();
    const denied = await perform(digest, { verdict: "deny", reason: "microsoft365 mail.send is refused by the action rules" }, []);
    expect(denied.outcome).toEqual({ outcome: "refused", error: "microsoft365 mail.send is refused by the action rules" });
    expect(denied.calls).toEqual([]);
    expect((await perform(digest, { verdict: "allow" }, [], { now: { ...account, tenantId: "another" } })).outcome).toMatchObject({ outcome: "refused" });
    expect((await perform(digest, { verdict: "allow" }, [], { now: undefined })).outcome).toMatchObject({ outcome: "refused" });
    expect((await perform(digest, { verdict: "allow" }, [], { now: { ...account, access: "read" } })).outcome).toMatchObject({ outcome: "refused", error: expect.stringContaining("read-only") });
    const text = await readFile(join(dir, `${digest}.json`), "utf8");
    await writeFile(join(dir, `${digest}.json`), text.replace("Treść", "Something else"));
    const tampered = await perform(digest, { verdict: "allow" }, []);
    expect(tampered.outcome).toEqual({ outcome: "refused", error: "the held request no longer matches what was approved" });
    expect(tampered.calls).toEqual([]);
    expect(digestOf(text)).toBe(digest);
});

test("Graph refusing an approved action reached nothing; a server failure may have gone through", async () => {
    const { digest } = await hold();
    expect((await perform(digest, { verdict: "allow" }, [{ status: 403, body: {} }])).outcome).toMatchObject({ outcome: "refused" });
    const failed = await perform(digest, { verdict: "allow" }, [{ status: 503, body: {} }]);
    expect(failed.outcome).toMatchObject({ outcome: "uncertain" });
    expect(failed.door.outcomes).toMatchObject([{ outcome: "error" }]);
    // An uncertain one stays held: never sent again by itself, and its yes is already spent.
    expect(await readdir(dir)).toEqual([`${digest}.json`]);
});
