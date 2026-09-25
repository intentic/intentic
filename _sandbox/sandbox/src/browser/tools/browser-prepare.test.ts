import type { Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { prepareKnownOwner } from "./browser-prepare.js";

// The daemon's side of a turn's browser routers: which owners a router may have built. What a prepare actually builds
// is browser-tools.integration.test.ts's business, how a router routes is browser-router.integration.test.ts's, and the
// door its MCP client reaches it through is agent/tools/turn-mounts.test.ts's.

const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };

const servicesHolding = (capabilities: readonly Capability[] = [reddit]) =>
    unstubbed<Pick<Services, "capabilities" | "workspace">>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root: "/nonexistent-workspace" }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [...capabilities] }),
    });

test("an owner this sandbox does not hold is refused by name, not built", async () => {
    expect(await prepareKnownOwner(servicesHolding(), "../../etc", 41_000)).toEqual({
        refusal: 'no browser profile named "../../etc" in this sandbox',
    });
});

// A capability was granted, so the answer is about the browser (absent on a CI image), never about the name.
test("an owner this sandbox does hold gets past the name check", async () => {
    const answer = (await prepareKnownOwner(servicesHolding(), "reddit", 41_000)) as { refusal?: string };
    expect(answer.refusal ?? "").not.toContain("no browser profile named");
});
