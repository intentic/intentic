import { registerConformance } from "../kit/scenario.js";
import { conformance } from "./cloudflare.conformance.js";
import { cloudflareWorld } from "./cloudflare.world.js";

registerConformance({
    name: "Cloudflare capability conformance (fake)",
    kind: "fake",
    scenarios: conformance,
    secrets: [],
    create: () => cloudflareWorld("fake"),
});
