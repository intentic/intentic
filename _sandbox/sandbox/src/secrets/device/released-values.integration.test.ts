import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { decryptAtRest } from "../../store/encryption/at-rest.js";
import { RELEASED_VALUES_FILE, releasedDeviceValues } from "./keyring-stores.js";

// What this sandbox keeps of a value a computer's keyring released for one use: masked by the daemon while its use can
// still print it, written for the terminal's filter only when a process was handed it, and gone from both once its
// window passes. The file is opened as the filter opens it: sealed under the at-rest key where the run holds one.

const dirs: string[] = [];
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const KEEP_MS = 60_000;

// The file's flat layout, the one the terminal filter reads every store in.
const FlatSchema = z.record(z.string(), z.string());

const released = async () => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-released-"));
    dirs.push(dir);
    const path = join(dir, RELEASED_VALUES_FILE);
    let at = 1_000;
    const warned: string[] = [];
    const values = releasedDeviceValues(path, (message) => void warned.push(message), { now: () => at, keepMs: KEEP_MS });
    // Waits for the queued write by way of reset, which writes the file again from memory and nothing else.
    const onDisk = async (): Promise<z.infer<typeof FlatSchema> | "absent"> => {
        await values.reset();
        const text = await readFile(path, "utf8").catch(() => undefined);
        return text === undefined ? "absent" : FlatSchema.parse(JSON.parse(await decryptAtRest(text, RELEASED_VALUES_FILE)));
    };
    return { path, values, onDisk, warned, pass: (ms: number) => void (at += ms) };
};

test("a value handed to a shell is masked and written for the filter, and gone from both once its window passes", async () => {
    const { path, values, onDisk, warned, pass } = await released();
    values.add("VPN_PASSWORD", "synthetic-vpn-password", "shell");
    expect(values.all()).toEqual({ VPN_PASSWORD: "synthetic-vpn-password" });
    expect(await onDisk()).toEqual({ VPN_PASSWORD: "synthetic-vpn-password" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    pass(KEEP_MS - 1);
    expect(values.all()).toEqual({ VPN_PASSWORD: "synthetic-vpn-password" });
    pass(1);
    expect(values.all()).toEqual({});
    expect(await onDisk()).toBe("absent");
    expect(warned).toEqual([]);
});

test("a value typed into a browser or a window is masked by the daemon alone, never written", async () => {
    const { values, onDisk, pass } = await released();
    values.add("SITE_PASSWORD", "synthetic-site-password", "browser");
    values.add("APP_PASSWORD", "synthetic-app-password", "desktop");
    expect(values.all()).toEqual({ SITE_PASSWORD: "synthetic-site-password", APP_PASSWORD: "synthetic-app-password" });
    expect(await onDisk()).toBe("absent");
    pass(KEEP_MS);
    expect(values.all()).toEqual({});
});

test("a second release of the same name starts its window again, and one window ending leaves the others", async () => {
    const { values, onDisk, pass } = await released();
    values.add("VPN_PASSWORD", "synthetic-vpn-password", "shell");
    pass(KEEP_MS / 2);
    values.add("DB_PASSWORD", "synthetic-db-password", "code");
    values.add("VPN_PASSWORD", "synthetic-vpn-password", "shell");
    pass(KEEP_MS / 2 + 1);
    expect(values.all()).toEqual({ VPN_PASSWORD: "synthetic-vpn-password", DB_PASSWORD: "synthetic-db-password" });
    pass(KEEP_MS / 2);
    expect(values.all()).toEqual({});
    expect(await onDisk()).toBe("absent");
});
