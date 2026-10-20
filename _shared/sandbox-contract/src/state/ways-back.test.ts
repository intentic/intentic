import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { DeviceFeatureSchema } from "../schemas/hosts.js";
import { waysBack } from "./ways-back.js";

// What `ic features --json` answers (_sandbox/ic/src/features.rs holds the same list to this golden).
// SAFETY: the golden is this package's own file; the assertions below fail on any field it lacks.
const IC_FEATURES = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "golden", "ic-features.json"), "utf8")) as { readonly features: readonly string[] };

const pruned = (image: string, version: string) => ({ image, version, download: true });
const kept = (image: string, version: string) => ({ image, version });

test("every feature ic says it has is one the contract knows, the reachable listing among them", () => {
    for (const feature of IC_FEATURES.features) {
        expect(DeviceFeatureSchema.safeParse(feature).success).toBe(true);
    }
    expect(IC_FEATURES.features).toContain("reachable-ways-back");
});

test("a current ic's ways back are offered as it lists them, each image once", () => {
    const current = { features: [...IC_FEATURES.features] };
    const pin = kept("pin:a", "1.2.0");
    const release = pruned("ghcr.io/intentic/sandbox:1.1.0", "1.1.0");
    expect(waysBack(current, [pin, pin, release])).toEqual([pin, release]);
});

// 2026-10-19: an ic from before then listed pruned dev builds, rows of 0.0.0 no download can bring back.
test("an older ic's rows it could never reach are left out, and only those", () => {
    const older = { features: ["rollback-to", "sleep"] };
    const dev = kept("pin:dev", "0.0.0");
    const release = pruned("pin:gone", "1.1.0");
    const rows = [dev, pruned("pin:gone-dev", "0.0.0"), release, { image: "pin:nameless", download: true }];
    expect(waysBack(older, rows)).toEqual([dev, release]);
    expect(waysBack(undefined, rows)).toEqual([dev, release]);
});
