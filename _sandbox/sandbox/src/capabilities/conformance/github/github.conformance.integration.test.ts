import { registerConformance } from "../kit/scenario.js";
import { conformance } from "./github.conformance.js";
import { githubWorld } from "./github.world.js";
import { created } from "../../../definition/workspace-repo.js";

registerConformance({
    name: "GitHub capability conformance (fake)",
    kind: "fake",
    scenarios: conformance,
    secrets: [],
    create: () => githubWorld("fake", created),
});
