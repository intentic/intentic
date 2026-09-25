import { testIngressConfig } from "../testing.js";
import { declaredTransports, edgeTransportReader } from "./edge-transports.js";

type Ask = Parameters<typeof edgeTransportReader>[0];

const answering = (body: unknown, status = 200): { ask: Ask; asked: string[] } => {
    const asked: string[] = [];
    const ask: Ask = async (url) => {
        asked.push(url);
        return new Response(JSON.stringify(body), { status });
    };
    return { ask, asked };
};

const testConfig = () => ({ ingress: { ...testIngressConfig } });

describe(`edge transports`, () => {
    it(`reads what the edge's /health declares, and only the tokens this build knows`, () => {
        expect(declaredTransports({ transports: [`webtransport`, `carrier-pigeon`, `quic`] })).toEqual([`quic`, `webtransport`]);
        expect(declaredTransports({ status: `ok`, build: `abc` })).toEqual([]);
        expect(declaredTransports(undefined)).toEqual([]);
    });

    it(`asks the configured edge once a minute and shares the answer`, async () => {
        let clock = 0;
        const { ask, asked } = answering({ transports: [`quic`, `h3`, `webtransport`] });
        const reader = edgeTransportReader(ask, () => clock);
        const read = reader.read;
        const config = testConfig();
        expect(reader.held()).toEqual([]);
        const [first, second] = await Promise.all([read(config), read(config)]);
        expect(first).toEqual([`quic`, `h3`, `webtransport`]);
        expect(second).toEqual(first);
        expect(reader.held()).toEqual(first);
        clock = 59_999;
        await read(config);
        expect(asked).toEqual([`${config.ingress.url}/health`]);
        clock = 60_000;
        await read(config);
        expect(asked).toHaveLength(2);
    });

    it(`reads an edge that refuses, fails or has no address as declaring nothing`, async () => {
        const config = testConfig();
        expect(await edgeTransportReader(answering({ transports: [`quic`] }, 503).ask).read(config)).toEqual([]);
        const failing: Ask = async () => {
            throw new TypeError(`fetch failed`);
        };
        expect(await edgeTransportReader(failing).read(config)).toEqual([]);
        const { ask, asked } = answering({ transports: [`quic`] });
        expect(await edgeTransportReader(ask).read({ ...config, ingress: { ...config.ingress, url: `` } })).toEqual([]);
        expect(asked).toEqual([]);
    });
});
