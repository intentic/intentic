import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginStatus } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { createLogger } from "../../logger.js";
import { testConfig } from "../../testing.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { identityIn } from "./vendor-cli-identity.js";
import { deviceCodeOf } from "./vendor-cli-login.js";
import * as vendorCliOriginal from "./vendor-cli.js";
import type { VendorCli } from "./vendor-cli.js";

/* A vendor CLI's sign-in end to end, against a scripted CLI: page and code out, approval, the home adopted as the account's. */

// The fake CLI: prints a device code as Kimi's does, waits for the test to approve (a file appearing), then writes a
// token file naming who signed in into the home it was pointed at and exits 0; or exits 1 with a refusal.
const SCRIPT = `#!/bin/sh
printf 'Opening browser for device login: https://example.com/device?user_code=ABCD-EFGH\\n' >&2
printf 'If the browser did not open, paste the URL above and enter code: ABCD-EFGH\\n' >&2
while [ ! -e "$FAKE_CLI_HOME/../approve" ] && [ ! -e "$FAKE_CLI_HOME/../deny" ]; do sleep 0.05; done
if [ -e "$FAKE_CLI_HOME/../deny" ]; then printf 'Login failed: access denied\\n' >&2; exit 1; fi
mkdir -p "$FAKE_CLI_HOME/credentials"
printf '{"user":{"email":"%s"},"access_token":"t"}' "$(cat "$FAKE_CLI_HOME/../approve")" > "$FAKE_CLI_HOME/credentials/kimi.json"
exit 0
`;

let root = "";
let script = "";

jest.mock("./vendor-cli.js", () => ({ ...vendorCliOriginal, ensureCli: async () => script }));
const { cliAccountDoor } = await import("./vendor-cli-door.js");
const { fileCliStore } = await import("./vendor-cli-store.js");

const FAKE: VendorCli = {
    provider: "kimi",
    name: "Fake CLI",
    runtime: "kimi-cli",
    engine: "kimi",
    door: "kimi-cli",
    authDir: "fake-cli",
    launch: (binary, home) => ({ argv: [binary, "acp"], env: { FAKE_CLI_HOME: home } }),
    login: { argv: (binary) => [binary], env: (home) => ({ FAKE_CLI_HOME: home }), deviceCode: deviceCodeOf },
    identity: (home) => identityIn([join(home, "credentials", "kimi.json")]),
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vendor-cli-door-"));
    script = join(root, "fake-cli");
    await writeFile(script, SCRIPT);
    await chmod(script, 0o755);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const doorOver = () => {
    const dropped: string[] = [];
    const store = fileCliStore(join(root, "auth", FAKE.authDir), FAKE, createLogger(testConfig));
    const forgotten = { models: 0 };
    const door = cliAccountDoor(
        FAKE,
        store,
        {
            forget: () => {
                forgotten.models += 1;
            },
        },
        unstubbed<Parameters<typeof cliAccountDoor>[3]>("door deps", {
            authRoot: join(root, "auth"),
            acpConnections: unstubbed("acpConnections", { drop: (id: string) => void dropped.push(id) }),
            composeEnvironment: async () => {},
            headroom: unstubbed("headroom", { clear: async () => {} }),
            observedLimits: unstubbed("observedLimits", { clear: async () => {} }),
            providerRefusals: unstubbed("providerRefusals", { clear: async () => {} }),
        }),
    );
    return { door, store, dropped, forgotten };
};

// Where the attempt's home sits: the script looks for its answer one level up, in the attempt's own directory.
const attemptDir = (handshake: string): string => join(root, "auth", FAKE.authDir, ".signing-in", handshake);

const settledStatus = async (door: AccountDoor, handshake: string): Promise<LoginStatus> => {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const status = door.status?.(handshake) ?? { status: "wait" };
        if (status.status !== "wait" || Date.now() > deadline) {
            return status;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- waiting on the CLI the attempt runs
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

test("the CLI's page and code reach the card, and its approved home becomes the account's", async () => {
    const { door, store, forgotten } = doorOver();
    const started = await door.start("kimi-cli");
    expect(started).toEqual(
        expect.objectContaining({ url: "https://example.com/device?user_code=ABCD-EFGH", code: "ABCD-EFGH", flow: "device", variant: "kimi-cli" }),
    );
    await writeFile(join(attemptDir(started.handshake), "approve"), "me@example.com");
    const status = await settledStatus(door, started.handshake);
    expect(status).toEqual({
        status: "ok",
        account: expect.objectContaining({ email: "me@example.com", label: "me@example.com", variant: "kimi-cli" }),
    });
    const [row] = await door.list(false);
    expect(row).toEqual(expect.objectContaining({ email: "me@example.com", variant: "kimi-cli" }));
    // The CLI's own token file, moved whole into the account's home; the attempt's directory is gone.
    expect(JSON.parse(await readFile(join(store.homeOf(row!.id), "credentials", "kimi.json"), "utf8"))).toEqual(
        expect.objectContaining({ access_token: "t" }),
    );
    await expect(readFile(join(attemptDir(started.handshake), "approve"), "utf8")).rejects.toThrow();
    expect(forgotten.models).toBe(1);
});

test("the same person signing in again lands on their account's id", async () => {
    const { door } = doorOver();
    const first = await door.start("kimi-cli");
    await writeFile(join(attemptDir(first.handshake), "approve"), "me@example.com");
    await settledStatus(door, first.handshake);
    const second = await door.start("kimi-cli");
    await writeFile(join(attemptDir(second.handshake), "approve"), "ME@example.com");
    await settledStatus(door, second.handshake);
    const rows = await door.list(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.handshake);
});

test("a sign-in the vendor refuses ends with the CLI's own words, and leaves no account", async () => {
    const { door } = doorOver();
    const started = await door.start("kimi-cli");
    await writeFile(join(attemptDir(started.handshake), "deny"), "");
    expect(await settledStatus(door, started.handshake)).toEqual({ status: "error", error: expect.stringContaining("Login failed: access denied") });
    expect(await door.list(false)).toEqual([]);
});

test("disconnecting ends the account's process and removes its home", async () => {
    const { door, store, dropped } = doorOver();
    const started = await door.start("kimi-cli");
    await writeFile(join(attemptDir(started.handshake), "approve"), "me@example.com");
    await settledStatus(door, started.handshake);
    await door.forget(started.handshake);
    expect(dropped).toContain(`kimi-cli:${started.handshake}`);
    expect(await door.list(false)).toEqual([]);
    await expect(readFile(join(store.homeOf(started.handshake), "credentials", "kimi.json"), "utf8")).rejects.toThrow();
});
