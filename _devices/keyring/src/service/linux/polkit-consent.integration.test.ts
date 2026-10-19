import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Consent, ConsentRequest, VaultOpener } from "../../consent/consent.js";
import type { RunAnswer, Runner } from "../../run.js";
import { newVaultKey, sameKey, unwrapPassphrase, wrapWithPassphrase } from "../../vault.js";
import { polkitConsent } from "./polkit-linux.js";
import { ServiceKey } from "../service-key.js";

/* A yes on Linux: polkit asked by the service about the helper's process, and a locked vault opened with the service's
   own key; the recovery key where polkit cannot ask, or for a vault the service has no wrap of yet. pkcheck is a fake. */

const SUBJECT = { pid: 42, start: "1", uid: "1000" };
const RECOVERY = "01234-56789-ABCDE-FGHJK-MNPQR-STVWX";

const exits =
    (code: number | null, missing = false): Runner =>
    (): Promise<RunAnswer> =>
        Promise.resolve({ exitCode: code, stdout: "", stderr: "", timedOut: false, missing, startError: undefined });

const recoveryWith = (key: Buffer): Consent & { asked: number } => {
    const consent = {
        asked: 0,
        hello: undefined,
        ask: (request: ConsentRequest) => {
            consent.asked++;
            return Promise.resolve(request.unlock ? { ok: true as const, vaultKey: key, how: "passphrase" as const } : { ok: true as const, vaultKey: undefined, how: "verified" as const });
        },
    };
    return consent;
};

const OPENER: VaultOpener = { withPassphrase: () => Promise.resolve(undefined) };
const request = (unlock: boolean): ConsentRequest => ({ title: "Unlock", message: "m", unlock, opener: OPENER });

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "service-key-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("a polkit yes opens a locked vault with the service's key, asking nothing else", async () => {
    const vaultKey = newVaultKey();
    const serviceKey = new ServiceKey(join(dir, "service-key.json"), dir);
    await serviceKey.adopt(Buffer.from(vaultKey));
    const recovery = recoveryWith(vaultKey);
    const answer = await polkitConsent({ runner: exits(0), helper: () => SUBJECT, serviceKey, recovery }).ask(request(true));
    expect(answer.ok && answer.vaultKey !== undefined && sameKey(answer.vaultKey, vaultKey)).toBe(true);
    expect(recovery.asked).toBe(0);
});

test("a polkit no is a no, and no helper is nobody to ask", async () => {
    const serviceKey = new ServiceKey(join(dir, "service-key.json"), dir);
    const recovery = recoveryWith(newVaultKey());
    expect(await polkitConsent({ runner: exits(1), helper: () => SUBJECT, serviceKey, recovery }).ask(request(false))).toMatchObject({ ok: false, code: "declined" });
    expect(await polkitConsent({ runner: exits(0), helper: () => undefined, serviceKey, recovery }).ask(request(true))).toMatchObject({ ok: false, code: "locked" });
    expect(recovery.asked).toBe(0);
});

test("a vault from before asks its recovery key once, then a polkit yes alone opens it", async () => {
    const vaultKey = newVaultKey();
    const serviceKey = new ServiceKey(join(dir, "service-key.json"), dir);
    const recovery = recoveryWith(vaultKey);
    const consent = polkitConsent({ runner: exits(0), helper: () => SUBJECT, serviceKey, recovery });
    expect((await consent.ask(request(true))).ok).toBe(true);
    expect(recovery.asked).toBe(1);
    expect((await consent.ask(request(true))).ok).toBe(true);
    expect(recovery.asked).toBe(1);
});

test("where polkit cannot ask, the recovery key is asked instead", async () => {
    const serviceKey = new ServiceKey(join(dir, "service-key.json"), dir);
    const recovery = recoveryWith(newVaultKey());
    expect((await polkitConsent({ runner: exits(null, true), helper: () => SUBJECT, serviceKey, recovery }).ask(request(false))).ok).toBe(true);
    expect(recovery.asked).toBe(1);
});

test("every vault the core writes keeps the service's wrap, beside the recovery key's", async () => {
    const vaultKey = newVaultKey();
    const serviceKey = new ServiceKey(join(dir, "service-key.json"), dir);
    const recoveryWrap = await wrapWithPassphrase(vaultKey, RECOVERY, { N: 2 ** 10, r: 8, p: 1 });
    const file = { v: 1 as const, wraps: [recoveryWrap], sealed: { iv: "", tag: "", data: "" }, open: { entries: [], backends: [], peers: [], revision: 0, copies: {}, pendingInbox: [], pendingSync: [] } };
    expect(await serviceKey.merged(file)).toBe(file);
    await serviceKey.adopt(vaultKey);
    const merged = await serviceKey.merged(file);
    expect(merged.wraps).toHaveLength(2);
    expect(await serviceKey.merged(merged)).toBe(merged);
    const opened = await unwrapPassphrase(merged.wraps, RECOVERY);
    expect(opened !== undefined && sameKey(opened, vaultKey)).toBe(true);
    // A new ServiceKey over the same file reads the same secret and wrap back.
    const again = await new ServiceKey(join(dir, "service-key.json"), dir).open();
    expect(again !== undefined && sameKey(again, vaultKey)).toBe(true);
});
