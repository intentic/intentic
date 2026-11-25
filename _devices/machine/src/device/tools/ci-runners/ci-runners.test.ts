import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { grantWith } from "../../device-testing.js";
import { auditDetail } from "../../audit-detail.js";
import { ScopeError } from "../../policy.js";
import { ciRunners, ciRunnerTools } from "./ci-runners.js";

/* The CI runner tools' floor: the "Run commands" switch, Linux, and a token that never reaches the audit log. */

const off: DeviceScopes = grantWith();

test("every runner tool needs Run commands", async () => {
    await expect(ciRunners(off)).rejects.toBeInstanceOf(ScopeError);
    expect(ciRunnerTools().map((each) => each.name)).toEqual(["ci_runners", "ci_runner_action", "ci_runner_logs", "ci_runner_register", "ci_runner_remove"]);
});

test("a registration's token is redacted in the audit log, the rest of the call kept", () => {
    const detail = auditDetail("ci_runner_register", { url: "https://github.com/intentic/intentic", token: "AABBCCDDEEFFGGHH", name: "z440-worker-4" });
    expect(detail).not.toContain("AABBCCDDEEFFGGHH");
    expect(detail).toContain('"token":"<16 characters>"');
    expect(detail).toContain("z440-worker-4");
});
