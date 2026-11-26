import { registerConformance } from "../kit/scenario.js";
import { conformance } from "./github.conformance.js";
import { githubWorld } from "./github.world.js";
import { forgeClientFor } from "../../../forge/client.js";

registerConformance({
    name: "GitHub capability conformance (live)",
    kind: "live",
    scenarios: conformance,
    secrets: ["GITHUB_E2E_TOKEN"],
    create: () => githubWorld("live", forgeClientFor),
});
