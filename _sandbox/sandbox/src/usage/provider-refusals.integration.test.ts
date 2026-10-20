import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { fileProviderRefusalStore } from "./provider-refusals.js";

// Path's parent directory doesn't exist yet; the store must create it on write.
const tempStore = () => {
    const path = join(mkdtempSync(join(tmpdir(), "provider-refusals-")), "history", "provider-refusals.json");
    return { store: fileProviderRefusalStore(path), path };
};

const DAY = 24 * 60 * 60_000;
const refusal = (over: Partial<ProviderRefusal> = {}): ProviderRefusal => ({
    at: Date.now(),
    kind: "limit",
    message: "You've reached your usage limit for this billing cycle.",
    ...over,
});

test("nothing is on file when nothing has ever been refused", async () => {
    const { store } = tempStore();
    expect(await store.onFile()).toEqual({});
});

// A refusal at 4am against an automation is exactly the one nobody's watching; it must still be there when somebody
// opens the tab.
test("a recorded refusal survives a fresh store over the same path", async () => {
    const { store, path } = tempStore();
    const kimi = refusal();
    await store.record("kimi", kimi);
    expect(await fileProviderRefusalStore(path).onFile()).toEqual({ kimi: [kimi] });
});

// 2026-10-11: the provider kept one refusal, last one wins, so another account's refusal erased the one that held a
// rounded 100 spent, and the account read as ready again. 2026-10-09: a routed model's bench was a second copy only the
// picker read. Each refusal is the latest of its kind for its own account and model, whatever is refused after it.
test("keeps every account's and every model's refusal on file, each the latest of its own scope", async () => {
    const { store, path } = tempStore();
    const spent = refusal({ at: Date.now() - 3_000, account: "claude-1", model: "claude-opus-5-5", resetsAt: 1_900_000_000 });
    const later = refusal({ at: Date.now() - 2_000, account: "claude-2" });
    const revoked = refusal({ kind: "auth", message: "OAuth token revoked", account: "claude-2" });
    const sol = refusal({ model: "gpt-6.1-sol", resetsAt: 1_900_000_000 });
    const luna = refusal({ model: "gpt-6-luna", resetsAt: 1_900_000_000 });
    for (const [provider, filed] of [["claude", spent], ["claude", later], ["claude", revoked], ["codex", sol], ["codex", luna]] as const) {
        await store.record(provider, filed);
    }
    const onFile = await fileProviderRefusalStore(path).onFile();
    expect(onFile[`claude`]).toEqual(expect.arrayContaining([spent, later, revoked]));
    expect(onFile[`claude`]).toHaveLength(3);
    expect(onFile[`codex`]).toEqual(expect.arrayContaining([sol, luna]));
    // The same scope refused again is the same fact restated: the newer one replaces it.
    const again = refusal({ account: "claude-1", model: "claude-opus-5-5", resetsAt: 1_900_003_600 });
    await store.record("claude", again);
    expect((await store.onFile())[`claude`]).toEqual(expect.arrayContaining([again, later, revoked]));
    expect((await store.onFile())[`claude`]).toHaveLength(3);
});

// A file an older release wrote kept the provider's last refusal under `provider` and an account's copy under
// `provider:account`: the same refusal twice, read as one.
test("reads an older release's provider slot and account copy of one refusal as that one refusal", async () => {
    const { store, path } = tempStore();
    const spent = refusal({ account: "claude-1", model: "claude-opus-5-5" });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ claude: spent, "claude:claude-1": spent }));
    expect(await store.onFile()).toEqual({ claude: [spent] });
});

// Scoped to the account it names: another healthy account succeeding must not erase this one's refusal. An unattributed
// refusal (CLIProxyAPI cooling every credential) is the one any success settles.
test("leaves a refusal that names another account alone, and settles one that names nobody", async () => {
    const { store } = tempStore();
    const claude = refusal({ kind: "entitlement", message: "organization has disabled", account: "claude-1" });
    await store.record("claude", claude);
    await store.record("codex", refusal({ message: "all credentials cooling down" }));

    await store.settle("claude", { account: "claude-2", model: undefined });
    await store.settle("claude", { account: undefined, model: undefined });
    await store.settle("gemini", { account: "never-refused", model: undefined });
    await store.settle("codex", { account: "codex-file-3", model: undefined });

    expect(await store.onFile()).toEqual({ claude: [claude] });
    // A turn that finally runs on the account settles it.
    await store.settle("claude", { account: "claude-1", model: "claude-haiku-4-5" });
    expect(await store.onFile()).toEqual({});
});

// 2026-10-17: a title job on Composer settled an Opus refusal two seconds after it was filed. A spent allowance is about
// the model it named; only an answer on that model, or one whose pools cover it, proves it over.
test("a spent allowance is settled by an answer on the model it named, or on one that covers it", async () => {
    const { store } = tempStore();
    await store.record("cursor", refusal({ account: "a", model: "claude-opus-5-5" }));
    await store.settle("cursor", { account: "a", model: "composer-2.5" });
    await store.settle("cursor", { account: "a", model: undefined });
    expect((await store.onFile())[`cursor`]).toHaveLength(1);
    await store.settle("cursor", { account: "a", model: "claude-opus-5-5" });
    expect(await store.onFile()).toEqual({});

    // 2026-10-20 (kind-cove): Codex meters every model from one allowance, so a Luna answer proves Sol's open too.
    await store.record("codex", refusal({ model: "gpt-6.1-sol" }));
    await store.settle("codex", { account: undefined, model: "gpt-6-luna", covers: (model) => model === "gpt-6.1-sol" });
    expect(await store.onFile()).toEqual({});
});

// A request already in flight when the refusal was filed was admitted before the pool ran dry: its answer is no proof the
// pool has room. On 2026-10-19 one sent at 11:39:09 and answered at 11:39:18 settled a "try again at 1:53 PM" filed at
// 11:39:13, and the turns refused on that account next found no instant to be booked for.
test("an answer settles only what was filed before its request went out", async () => {
    const { store } = tempStore();
    const filed = Date.now() - 5_000;
    const reopens = Math.round(Date.now() / 1000) + 7_200;
    await store.record("codex", refusal({ at: filed, model: "gpt-6.1-sol", resetsAt: reopens }));
    await store.settle("codex", { account: undefined, model: "gpt-6.1-sol", askedAt: filed - 4_000 });
    await store.settle("codex", { account: undefined, model: "gpt-6.1-sol", askedAt: filed });
    expect((await store.onFile())[`codex`]).toMatchObject([{ resetsAt: reopens }]);

    await store.settle("codex", { account: undefined, model: "gpt-6.1-sol", askedAt: filed + 1 });
    expect(await store.onFile()).toEqual({});
});

test("a refused account is settled by an answer on any model", async () => {
    const { store } = tempStore();
    await store.record("cursor", refusal({ kind: "entitlement", account: "a", model: "claude-opus-5-5" }));
    await store.settle("cursor", { account: "a", model: "composer-2.5" });
    expect(await store.onFile()).toEqual({});
});

// A disconnected account, a mark taken back by hand, a seat a probe found restored: whatever answered them.
test("drops what a caller picks of a provider's refusals, and answers whether anything was there", async () => {
    const { store } = tempStore();
    await store.record("cursor", refusal({ account: "a", model: "composer-2.5", byHand: true }));
    await store.record("cursor", refusal({ account: "b", model: "composer-2.5" }));
    expect(await store.drop("cursor", (filed) => filed.account === "a")).toBe(true);
    expect(await store.drop("cursor", (filed) => filed.account === "a")).toBe(false);
    expect((await store.onFile())[`cursor`]).toMatchObject([{ account: "b" }]);
});

test("tells every listener the provider's refusals as they stand after each change", async () => {
    const { store } = tempStore();
    const heard: (readonly ProviderRefusal[])[] = [];
    const unhear = store.onChange((provider, refusals) => provider === "codex" && heard.push(refusals));
    const sol = refusal({ model: "gpt-6.1-sol" });
    await store.record("codex", sol);
    await store.settle("codex", { account: undefined, model: "gpt-6.1-sol" });
    // A settle that finds nothing changes nothing, and says nothing.
    await store.settle("codex", { account: undefined, model: "gpt-6.1-sol" });
    unhear();
    expect(heard).toEqual([[sol], []]);
});

// Past a week a refusal's window has certainly reopened; serving it would put a stale alarm under a live meter.
// Forgotten on read, since a daemon that never refuses again writes nothing to prune it.
test("forgets a refusal old enough to describe a window that has since reopened", async () => {
    const { store } = tempStore();
    await store.record("kimi", refusal({ at: Date.now() - 8 * DAY }));
    await store.record("codex", refusal({ at: Date.now() - 6 * DAY }));
    expect(Object.keys(await store.onFile())).toEqual(["codex"]);
});

// 2026-10-18: a Cursor account refused outright (`[role_forbidden]`) read "blocked, an admin's to fix" for six days after
// the ledger that placed turns had let it go after one. One horizon, read by every surface: a day.
test("forgets an account refused outright, or a plan marked spent by hand, after a day", async () => {
    const { store } = tempStore();
    const message = "[role_forbidden] Cloud Agent is not available for non-billable admins.";
    await store.record("cursor", refusal({ kind: "entitlement", account: "a", message, at: Date.now() - DAY - 60_000 }));
    await store.record("cursor", refusal({ account: "b", model: "composer-2.5", byHand: true, at: Date.now() - DAY - 60_000 }));
    expect(await store.onFile()).toEqual({});
    await store.record("cursor", refusal({ kind: "entitlement", account: "a", message, at: Date.now() - DAY + 60_000 }));
    await store.record("cursor", refusal({ account: "b", model: "composer-2.5", byHand: true, at: Date.now() - DAY + 60_000 }));
    expect((await store.onFile())["cursor"]).toHaveLength(2);
});

// 2026-10-15: a refusal no reading can answer, with no reset named, stood a week against the spawn gate and the ladder
// for an allowance back in three and a half hours. Such a refusal (an admin's credit, or any refusal of a plan that
// publishes no reading, Cursor's) is believed as long as the ladder benches a refused rung; one that named its reset is
// believed until then.
test("forgets a refusal no reading can answer after two hours where it named no reset, and keeps one that did", async () => {
    const { store } = tempStore();
    const message = "You're out of usage. Switch to Auto or Composer 2.5, or ask your admin to increase your limit to continue.";
    const old = Date.now() - 2 * 60 * 60_000 - 60_000;
    await store.record("cursor", refusal({ message, account: "a", model: "claude-opus-5-5", at: old }));
    await store.record("codex", refusal({ message, unmetered: true, at: old }));
    expect(await store.onFile()).toEqual({});
    const resetsAt = Math.ceil(Date.now() / 1000) + 3_600;
    await store.record("cursor", refusal({ message, account: "a", model: "claude-opus-5-5", resetsAt, at: old }));
    // A plan that publishes readings is answered by them, so its refusal is kept the week.
    await store.record("claude", refusal({ account: "c", at: old }));
    expect(Object.keys(await store.onFile()).sort()).toEqual(["claude", "cursor"]);
});

// Which account a picker skips changes with each write: each recorded and settled refusal is a line somebody can read.
test("logs each refusal recorded, and a settle only when one was on file", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "provider-refusals-")), "history", "provider-refusals.json");
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const store = fileProviderRefusalStore(path, { log: (fields, message) => lines.push({ fields, message }) });
    await store.record("claude", refusal({ account: "first", resetsAt: 2_000_000_000 }));
    await store.record("claude", refusal({ account: "second" }));
    await store.settle("claude", { account: "third", model: undefined });
    await store.settle("claude", { account: "second", model: undefined });
    expect(lines.map((line) => line.message)).toEqual([
        "provider refusal: recorded claude limit for first",
        "provider refusal: recorded claude limit for second",
        "provider refusal: settled claude limit for second (second served)",
    ]);
    expect(lines[0]?.fields).toMatchObject({ provider: "claude", account: "first", resetsAt: "2033-05-18T03:33:20.000Z" });
    expect(lines[2]?.fields).toMatchObject({ settledBy: "second" });
});

// 2026-10-20: a spent allowance the provider gave no time for stood past its pool's reset until the next reading landed.
// The ledger files it with that pool's reset, read while the reading still shows the pool, so every verdict ends it there.
test("files a spent allowance that named no instant with the reset of the pool it was refused in", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "provider-refusals-")), "provider-refusals.json");
    const inAnHour = Math.floor(Date.now() / 1000) + 3_600;
    const reading = { measuredAt: Date.now() - 60_000, windows: [{ kind: "five_hour", utilization: 97, gates: "all" as const, resetsAt: inAnHour }] };
    const asked: string[] = [];
    const store = fileProviderRefusalStore(path, {
        accountsOf: async (provider) => {
            asked.push(provider);
            return [{ account: "team.json", usage: reading }];
        },
    });
    const spent = refusal({ model: "gpt-6.1-sol" });
    await store.record("codex", spent);
    expect((await fileProviderRefusalStore(path).onFile())[`codex`]).toEqual([{ ...spent, poolResetsAt: inAnHour }]);
    // The provider's own instant needs no stamp, and a refused sign-in has no pool: neither reads the accounts.
    const stated = refusal({ model: "gpt-6-luna", resetsAt: inAnHour + 60 });
    await store.record("codex", stated);
    await store.record("codex", refusal({ kind: "auth", account: "team.json" }));
    expect(asked).toEqual(["codex"]);
    expect((await store.onFile())[`codex`]).toEqual(expect.arrayContaining([stated]));
});

test("files a refusal unstamped when the accounts cannot be read, to stand until a reading answers it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "provider-refusals-")), "provider-refusals.json");
    const store = fileProviderRefusalStore(path, { accountsOf: async () => { throw new Error("translator down"); } });
    const spent = refusal({ model: "gpt-6.1-sol" });
    await store.record("codex", spent);
    expect((await store.onFile())[`codex`]).toEqual([spent]);
});
