import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandKey, fileCommandProfiles } from "./command-profiles.js";

// What each kind of heavy line took on its runner, as the placement reads it: one kind per suite, whatever filter a run
// named, memory planned for the worst recent run and time averaged.

describe("the kind a line is profiled under", () => {
    test("is a cargo line's verb and what decides its size, never its test filter or job count", () => {
        const one = commandKey("cargo-verify", "cargo test -j 2 -p shinobi-society --lib -- visibility::tests");
        expect(one).toBe("cargo-verify: cargo test --lib -p shinobi-society");
        expect(commandKey("cargo-verify", "cargo test -p shinobi-society --lib -- analytics::tests")).toBe(one);
        expect(commandKey("cargo-verify", "cargo test -p shinobi-society --release")).not.toBe(one);
        expect(commandKey("cargo", "cargo +nightly build -p integra-cli --bin integra")).toBe("cargo: cargo build --bin integra -p integra-cli");
    });

    test("is any other line's program and first two words", () => {
        expect(commandKey("vitest", "npx --no-install vitest run src/a.test.ts --reporter dot")).toBe("vitest: npx --no-install vitest");
    });
});

describe("the profiles", () => {
    test("reads an existing profile file and keeps its measurements on update", async () => {
        const root = mkdtempSync(join(tmpdir(), "profiles-"));
        writeFileSync(
            join(root, "offload-profiles.json"),
            JSON.stringify({ profiles: [{ key: "cargo: cargo test -p a", runs: 2, peakMemoryMb: 9_000, durationMs: 85_000, lastAt: 1_001, peaks: [9_000, 4_000] }] }),
        );
        const profiles = fileCommandProfiles(root, () => 1_002);
        expect(await profiles.lookup("cargo", "cargo test -p a")).toEqual({ key: "cargo: cargo test -p a", runs: 2, peakMemoryMb: 9_000, durationMs: 85_000, lastAt: 1_001 });
        await profiles.record("cargo", "cargo test -p a", { peakMemoryMb: 6_000, durationMs: 50_000 });
        expect(await profiles.list()).toEqual([{ key: "cargo: cargo test -p a", runs: 3, peakMemoryMb: 9_000, durationMs: 74_500, lastAt: 1_002 }]);
    });

    test("updates through separate handles keep every run", async () => {
        const root = mkdtempSync(join(tmpdir(), "profiles-"));
        const first = fileCommandProfiles(root, () => 1_000);
        const second = fileCommandProfiles(root, () => 1_000);
        await Promise.all([
            first.record("cargo", "cargo test -p a", { peakMemoryMb: 9_000 }),
            second.record("cargo", "cargo test -p a", { peakMemoryMb: 4_000 }),
        ]);
        expect(await first.list()).toEqual([{ key: "cargo: cargo test -p a", runs: 2, peakMemoryMb: 9_000, lastAt: 1_000 }]);
        expect(await second.list()).toEqual(await first.list());
    });

    test("plan memory by the worst of the last runs, average time, and survive a restart", async () => {
        const root = mkdtempSync(join(tmpdir(), "profiles-"));
        let clock = 1_000;
        const profiles = fileCommandProfiles(root, () => clock);
        await profiles.record("cargo-verify", "cargo test -p a", { peakMemoryMb: 9_000, durationMs: 100_000 });
        clock += 1;
        await profiles.record("cargo-verify", "cargo test -p a -- one::filter", { peakMemoryMb: 4_000, durationMs: 50_000 });
        expect(await profiles.lookup("cargo-verify", "cargo test -p a")).toEqual({ key: "cargo-verify: cargo test -p a", runs: 2, peakMemoryMb: 9_000, durationMs: 85_000, lastAt: 1_001 });
        expect(JSON.parse(readFileSync(join(root, "offload-profiles.json"), "utf8")).profiles).toHaveLength(1);
        expect(await fileCommandProfiles(root).lookup("cargo-verify", "cargo test -p a")).toMatchObject({ runs: 2, peakMemoryMb: 9_000 });
        expect(await profiles.lookup("cargo-verify", "cargo test -p b")).toBeUndefined();
    });
});
