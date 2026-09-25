import { readFileSync } from "node:fs";
import { EDGE_VERDICT_HEADER, edgeVerdictOf } from "../protocol/edge-verdict.js";
import { INGRESS_GRANT_HEADER, INGRESS_TUNNEL_PATH } from "../protocol/ingress-contract.js";
import { INGRESS_LANE_HEADER } from "../protocol/tunnel-lanes.js";
import { EDGE_TRANSPORTS, TERMINAL_PATH, WEBTRANSPORT_PATH } from "./browser-wire.js";

// The manifests `cargo test` writes from the Rust crates that define this wire: every value TypeScript restates is read
// back against them, so the two languages cannot drift and contract.lock.json pins what both agree on.
const manifest = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(`./generated/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

const tunnel = manifest("tunnel") as {
    path: string;
    headers: { grant: string; lane: string; transports: string };
    transports: string[];
};
const browser = manifest("browser-wire") as {
    edge: { verdictHeader: string; verdicts: { oneOf: { const: string }[] } };
    terminal: { path: string; upgrade: string };
    webTransport: { path: string };
};

describe("the wire outside oRPC, as the Rust crates define it", () => {
    it("names the tunnel door and its headers as the tunnel crate does", () => {
        expect({ path: INGRESS_TUNNEL_PATH, grant: INGRESS_GRANT_HEADER, lane: INGRESS_LANE_HEADER }).toEqual({
            path: tunnel.path,
            grant: tunnel.headers.grant,
            lane: tunnel.headers.lane,
        });
    });

    it("declares exactly the transports an edge may", () => {
        expect<readonly string[]>(EDGE_TRANSPORTS).toEqual(tunnel.transports);
    });

    it("reads the edge's verdicts and the browser's paths as browser-wire writes them", () => {
        const verdicts = browser.edge.verdicts.oneOf.map((verdict) => verdict.const);
        expect(verdicts).toEqual(["no-tunnel", "unknown-sandbox", "dropped"]);
        expect<readonly (string | undefined)[]>(verdicts.map((verdict) => edgeVerdictOf(verdict))).toEqual(verdicts);
        expect({ header: EDGE_VERDICT_HEADER, terminal: TERMINAL_PATH, session: WEBTRANSPORT_PATH, upgrade: "websocket" }).toEqual({
            header: browser.edge.verdictHeader,
            terminal: browser.terminal.path,
            session: browser.webTransport.path,
            upgrade: browser.terminal.upgrade,
        });
    });
});
