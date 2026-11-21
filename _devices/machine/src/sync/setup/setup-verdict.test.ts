import type { Pairing } from "../config.js";
import { mutagenFailureSaid } from "../mutagen.js";
import { notStartedReason, prepareFailureIn, setupEnding } from "./setup-verdict.js";

const PAIRING: Pairing = { sandboxUrl: "https://sandbox-abc.example.dev", sandboxId: "sandbox-abc", mode: "sync", localDir: "/home/ada/intentic/abc" };

// (2026-11-20, intentic#49) "Desktop sync is running." was said by every setup, while the agent's log said every pass
// that the folder's file sync could not be prepared.
describe("setupEnding", () => {
    it("says sync is running only once its session exists", () => {
        const ending = setupEnding(PAIRING, PAIRING.sandboxUrl, undefined);
        expect(ending.verdict).toBe("Desktop sync is running.");
        expect(ending.address).toBe(PAIRING.localDir);
    });

    it("says sync could not start, and why, when its session never came", () => {
        const ending = setupEnding(PAIRING, PAIRING.sandboxUrl, "Mutagen's agent bundle is missing.");
        expect(ending.verdict).toBe("Desktop sync couldn't start.");
        expect(ending.verdict).not.toContain("running");
        expect(ending.instruction.split("\n")[0]).toBe("Mutagen's agent bundle is missing.");
        expect(ending.address).toBe(PAIRING.localDir);
    });

    it("has no file sync to start for a mirror-only enrollment", () => {
        expect(setupEnding({ sandboxUrl: PAIRING.sandboxUrl, sandboxId: PAIRING.sandboxId, mode: "mirror" }, PAIRING.sandboxUrl, undefined).verdict).toBe("Enrolled for port mirroring.");
    });
});

describe("prepareFailureIn", () => {
    const LOG = [
        "2026-11-20T10:00:00Z   sandbox-other: preparing its file sync failed: not this one",
        "2026-11-20T10:00:01Z   sandbox-abc: preparing its file sync failed: mutagen sync exited with code 1",
        "2026-11-20T10:00:06Z   sandbox-abc: preparing its file sync failed: Mutagen's agent bundle C:\\bin\\mutagen-agents.tar.gz is missing",
        "",
    ].join("\n");

    it("takes the last reason logged for this pairing, and no other pairing's", () => {
        expect(prepareFailureIn(LOG, "sandbox-abc")).toBe("Mutagen's agent bundle C:\\bin\\mutagen-agents.tar.gz is missing");
        expect(prepareFailureIn(LOG, "sandbox-none")).toBeUndefined();
    });
});

describe("notStartedReason", () => {
    it("prefers what the agent logged, then what is wrong with Mutagen, then the wait's own account", () => {
        expect(notStartedReason("it broke", "bundle missing", "slow")).toBe("This device's agent could not start file sync: it broke");
        expect(notStartedReason(undefined, "bundle missing", "slow")).toBe("bundle missing");
        expect(notStartedReason(undefined, undefined, "slow")).toBe("slow");
    });
});

describe("mutagenFailureSaid", () => {
    const MUTAGEN_SAID =
        "Error: unable to connect to beta: unable to install agent: unable to get agent for platform: unable to locate agent bundle (search paths: [/bin /libexec])";

    it("says a missing agent bundle in plain words, naming where it belongs, instead of an exit code", () => {
        const said = mutagenFailureSaid("/home/ada/.intentic/machine/bin/mutagen", undefined, MUTAGEN_SAID);
        expect(said).toContain("Mutagen's agent bundle /home/ada/.intentic/machine/bin/mutagen-agents.tar.gz is missing");
        expect(said).toContain("fetches it again on its next pass");
        expect(said).not.toContain("code 1");
    });

    it("says a Mutagen the device refused to start as that refusal", () => {
        expect(mutagenFailureSaid("/bin/mutagen", "EACCES", "")).toContain("this device refused to start /bin/mutagen");
    });

    it("leaves every other failure to Mutagen's own words", () => {
        expect(mutagenFailureSaid("/bin/mutagen", undefined, "Error: unable to connect to beta: connection refused")).toBeUndefined();
    });
});
