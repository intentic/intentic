import { readFileSync } from "node:fs";
import { type TunnelLane, tunnelLaneNamed, tunnelLaneOf, tunnelLaneTable } from "./tunnel-lanes.js";

interface LaneCase {
    readonly host: string;
    readonly method: string;
    readonly path: string;
    readonly lane: TunnelLane;
}

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const CASES = (read("./ingress-contract.fixture.json") as { lanes: LaneCase[] }).lanes;

test("the table the Rust edge embeds is the raw routes' lanes as they stand (pnpm --filter @intentic/sandbox-contract lanes)", () => {
    expect(read("./tunnel-lanes.json")).toEqual(tunnelLaneTable());
});

test("every request the shared fixture names rides the lane it states", () => {
    expect(CASES.length).toBeGreaterThan(20);
    for (const { host, method, path, lane } of CASES) {
        expect({ host, method, path, lane: tunnelLaneOf(host, method, path) }).toEqual({ host, method, path, lane });
    }
});

test("a tunnel is interactive unless its upgrade names the bulk lane", () => {
    expect(tunnelLaneNamed("bulk")).toBe("bulk");
    expect(tunnelLaneNamed(undefined)).toBe("interactive");
    expect(tunnelLaneNamed("interactive")).toBe("interactive");
    expect(tunnelLaneNamed(["bulk", "bulk"])).toBe("interactive");
});
