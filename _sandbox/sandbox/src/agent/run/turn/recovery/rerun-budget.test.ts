import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { PreviousRun } from "../../../../system/boot/restarts/restart-record.js";
import { anotherRerunEarned, rerunsSpentWhy } from "./rerun-budget.js";

// 2026-11-17, the shinobi-society audit: two restarts twelve minutes apart cut the same working turns twice, and the
// second time they stood "its one re-run is already spent" until the owner typed Continue.

const worked: readonly TranscriptRow[] = [
    { role: "user", text: "wire the headtaker" },
    {
        role: "assistant",
        text: "Capturing each state.",
        tools: ["a", "b", "c"].map((id) => ({ id, name: "Bash", category: "execute" as const, status: "completed" as const })),
    },
];
const barely: readonly TranscriptRow[] = [
    { role: "user", text: "wire the headtaker" },
    { role: "assistant", text: "Looking.", tools: [{ id: "a", name: "Read", category: "read", status: "completed" }] },
];
const killed: PreviousRun = { ended: "killed", graceful: false };
const updated: PreviousRun = { ended: "stopped", graceful: true, intent: { at: "2026-11-17T00:00:00Z", by: "daemon", action: "update", reason: "update when quiet" } };
const repaired: PreviousRun = { ended: "exited", graceful: false, intent: { at: "2026-11-17T00:00:00Z", by: "keeper", action: "restart", reason: "unresponsive" } };
const asked: PreviousRun = { ended: "exited", graceful: false, intent: { at: "2026-11-17T00:00:00Z", by: "ic", action: "restart", reason: "ic restart" } };

describe("anotherRerunEarned", () => {
    it("earns one for a re-run that made progress before an unannounced kill", () => {
        expect(anotherRerunEarned({ attempts: 1 }, worked, {}, killed)).toBe(true);
    });

    it("earns one when the sandbox restarted itself, even for a re-run that did little", () => {
        expect(anotherRerunEarned({ attempts: 1 }, barely, {}, updated)).toBe(true);
        expect(anotherRerunEarned({ attempts: 1 }, undefined, {}, asked)).toBe(true);
    });

    it("earns none for a re-run that died where it started under a kill or a keeper's repair", () => {
        expect(anotherRerunEarned({ attempts: 1 }, barely, {}, killed)).toBe(false);
        expect(anotherRerunEarned({ attempts: 1 }, barely, {}, repaired)).toBe(false);
        expect(anotherRerunEarned({ attempts: 1 }, undefined, {}, undefined)).toBe(false);
    });

    it("earns none past the ceiling, however much it did", () => {
        expect(anotherRerunEarned({ attempts: 2 }, worked, {}, updated)).toBe(true);
        expect(anotherRerunEarned({ attempts: 3 }, worked, {}, updated)).toBe(false);
    });

    it("earns none for a restart memory caused: the out-of-memory loop guard keeps its strict count", () => {
        expect(anotherRerunEarned({ attempts: 1 }, worked, { memory: { summary: "a job grew", culprits: new Set<string>() } }, updated)).toBe(false);
    });
});

describe("rerunsSpentWhy", () => {
    it("says whether the first re-run or the ceiling was spent", () => {
        expect(rerunsSpentWhy(1)).toBe("its one re-run is already spent, and the run it cut made too little progress to earn another");
        expect(rerunsSpentWhy(3)).toBe("all 3 of its re-runs are already spent");
    });
});
