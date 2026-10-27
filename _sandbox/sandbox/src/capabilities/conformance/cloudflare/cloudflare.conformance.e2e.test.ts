import { registerConformance } from "../kit/scenario.js";
import { conformance } from "./cloudflare.conformance.js";
import { cloudflareWorld } from "./cloudflare.world.js";

registerConformance({
    name: "Cloudflare capability conformance (live)",
    kind: "live",
    scenarios: conformance,
    secrets: ["CLOUDFLARE_E2E_TOKEN"],
    create: () => cloudflareWorld("live"),
});
