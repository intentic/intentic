import { readFileSync } from "node:fs";
import { EDGE_VERDICT_HEADER, edgeVerdictOf } from "../protocol/edge-verdict.js";
import { INGRESS_GRANT_HEADER, INGRESS_TUNNEL_PATH } from "../protocol/ingress-contract.js";
import { VITALS_FILE, VITALS_PATH } from "../protocol/vitals.js";
import {
    BROWSER_FRAME_TAGS,
    BROWSER_MEDIA_PATH,
    BROWSER_MEDIA_SOCKET_DIR,
    BROWSER_VIEW_PATH,
    DEVICE_HEADER,
    DEVICE_MEDIA_PATH,
    DEVICE_SOCKET_DIR,
    DEVICE_TERMINAL_PATH,
    DEVICE_UPLINK_CLOSE_CODES,
    DEVICE_UPLINK_PATH,
    EDGE_TRANSPORTS,
    MEDIA_CLIP_LEN,
    MEDIA_CLOSE_CODES,
    MEDIA_FLAGS,
    MEDIA_HEADER_LEN,
    MEDIA_KINDS,
    MEDIA_LOSSLESS_QUERY,
    MEDIA_TOKEN_GRACE_SECONDS,
    RTC_CHANNELS,
    RTC_MESSAGE_MAX,
    RUNNER_HEADER,
    RUNNER_UPLINK_CLOSE_CODES,
    RUNNER_UPLINK_PATH,
    RUNNER_VIEW_PATH,
    RUNNER_VIEW_TICKET,
    TERMINAL_PATH,
    WEBTRANSPORT_PATH,
} from "./browser-wire.js";
import {
    ASK_PATIENCE_MS,
    FRAME_LENGTH_BYTES,
    FRAME_MAX_BYTES,
    INSTANCE_ENV,
    NETD_SOCKET_ENV,
    NODE_GENERATION_ENV,
    NODE_SOCKET_ENV,
} from "./netd-wire.js";

// The manifests `cargo test` writes from the Rust crates that define this wire: every value TypeScript restates is read
// back against them, so the two languages cannot drift and contract.lock.json pins what both agree on.
const manifest = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(`./generated/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

const tunnel = manifest("tunnel") as {
    path: string;
    headers: { grant: string; transports: string };
    transports: string[];
};
// SAFETY: netd-wire's own test writes this manifest with exactly these keys, and the lock pins them.
const socket = manifest("netd-wire") as {
    env: { netdSocket: string; nodeSocket: string; generation: string; instance: string };
    askPatienceMs: number;
    frame: { lengthBytes: number; maxBytes: number };
};
const browser = manifest("browser-wire") as {
    browserView: { path: string; frameTags: Record<string, number> };
    browserMedia: {
        path: string;
        socketDir: string;
        headerLen: number;
        kinds: Record<string, number>;
        flags: Record<string, number>;
        clipLen: number;
        losslessQuery: string;
        rtcChannels: Record<string, { ordered: boolean; maxRetransmits: number | null }>;
        rtcMessageMax: number;
        tokenGraceSeconds: number;
        closeCodes: Record<string, number>;
    };
    device: {
        mediaPath: string;
        terminalPath: string;
        uplinkPath: string;
        header: string;
        socketDir: string;
        closeCodes: Record<string, number>;
    };
    runner: { uplinkPath: string; header: string; viewPath: string; viewTicket: string; closeCodes: Record<string, number> };
    edge: { verdictHeader: string; verdicts: { oneOf: { const: string }[] } };
    terminal: { path: string; upgrade: string };
    vitals: { path: string; file: string; body: { $defs: { NodeLink: { oneOf: { const: string }[] } } } };
    webTransport: { path: string };
};

describe("the wire outside oRPC, as the Rust crates define it", () => {
    it("names the tunnel door and its headers as the tunnel crate does", () => {
        expect({ path: INGRESS_TUNNEL_PATH, grant: INGRESS_GRANT_HEADER }).toEqual({
            path: tunnel.path,
            grant: tunnel.headers.grant,
        });
    });

    it("names the control socket's env vars, its patience and its framing as netd-wire does", () => {
        expect({
            netd: NETD_SOCKET_ENV,
            node: NODE_SOCKET_ENV,
            generation: NODE_GENERATION_ENV,
            instance: INSTANCE_ENV,
            patience: ASK_PATIENCE_MS,
            length: FRAME_LENGTH_BYTES,
            max: FRAME_MAX_BYTES,
        }).toEqual({
            netd: socket.env.netdSocket,
            node: socket.env.nodeSocket,
            generation: socket.env.generation,
            instance: socket.env.instance,
            patience: socket.askPatienceMs,
            length: socket.frame.lengthBytes,
            max: socket.frame.maxBytes,
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

    it("opens the browser view where browser-wire says, and tags its pictures as it numbers them", () => {
        expect(BROWSER_VIEW_PATH).toBe(browser.browserView.path);
        expect<Record<string, number>>(BROWSER_FRAME_TAGS).toEqual(browser.browserView.frameTags);
    });

    it("opens a window's media socket where browser-wire says, and reads its header as it lays it out", () => {
        expect(BROWSER_MEDIA_PATH).toBe(browser.browserMedia.path);
        expect(BROWSER_MEDIA_SOCKET_DIR).toBe(browser.browserMedia.socketDir);
        expect(MEDIA_HEADER_LEN).toBe(browser.browserMedia.headerLen);
        expect<Record<string, number>>(MEDIA_KINDS).toEqual(browser.browserMedia.kinds);
        expect<Record<string, number>>(MEDIA_FLAGS).toEqual(browser.browserMedia.flags);
        expect(MEDIA_CLIP_LEN).toBe(browser.browserMedia.clipLen);
        expect(MEDIA_LOSSLESS_QUERY).toBe(browser.browserMedia.losslessQuery);
        expect(MEDIA_TOKEN_GRACE_SECONDS).toBe(browser.browserMedia.tokenGraceSeconds);
        expect<Record<string, number>>(MEDIA_CLOSE_CODES).toEqual(browser.browserMedia.closeCodes);
        expect<Record<string, { ordered: boolean; maxRetransmits: number | null }>>(RTC_CHANNELS).toEqual(browser.browserMedia.rtcChannels);
        expect(RTC_MESSAGE_MAX).toBe(browser.browserMedia.rtcMessageMax);
    });

    it("opens a connected computer's screen, terminal and uplink where browser-wire says", () => {
        expect({
            media: DEVICE_MEDIA_PATH,
            terminal: DEVICE_TERMINAL_PATH,
            uplink: DEVICE_UPLINK_PATH,
            header: DEVICE_HEADER,
            socketDir: DEVICE_SOCKET_DIR,
        }).toEqual({
            media: browser.device.mediaPath,
            terminal: browser.device.terminalPath,
            uplink: browser.device.uplinkPath,
            header: browser.device.header,
            socketDir: browser.device.socketDir,
        });
        expect<Record<string, number>>(DEVICE_UPLINK_CLOSE_CODES).toEqual(browser.device.closeCodes);
    });

    it("dials a runner's uplink and opens a runner's views where browser-wire says", () => {
        expect({ uplink: RUNNER_UPLINK_PATH, header: RUNNER_HEADER, view: RUNNER_VIEW_PATH, ticket: RUNNER_VIEW_TICKET }).toEqual({
            uplink: browser.runner.uplinkPath,
            header: browser.runner.header,
            view: browser.runner.viewPath,
            ticket: browser.runner.viewTicket,
        });
        expect<Record<string, number>>(RUNNER_UPLINK_CLOSE_CODES).toEqual(browser.runner.closeCodes);
    });

    it("finds netd's vitals where browser-wire says it answers them, in the states it names", () => {
        expect(VITALS_PATH).toBe(browser.vitals.path);
        expect(VITALS_FILE).toBe(browser.vitals.file);
        expect(browser.vitals.body.$defs.NodeLink.oneOf.map((state) => state.const)).toEqual(["starting", "up", "restarting"]);
    });
});
