import { reachPosture, tunnelUrl } from "./reach-posture.js";

describe(`tunnelUrl`, () => {
    test(`derives the versioned websocket door from the edge's https address`, () => {
        expect(tunnelUrl(`https://ingress.sbx.intentic.dev`)).toBe(`wss://ingress.sbx.intentic.dev/tunnel/v2`);
    });

    test(`keeps a plaintext edge plaintext`, () => {
        expect(tunnelUrl(`http://localhost:8080`)).toBe(`ws://localhost:8080/tunnel/v2`);
    });

    test(`ignores a path on the base address`, () => {
        expect(tunnelUrl(`https://edge.example.test/ignored`)).toBe(`wss://edge.example.test/tunnel/v2`);
    });
});

describe(`reachPosture`, () => {
    const base = { url: `https://ingress.example.test`, grant: `ig1.a.b`, frontDoor: true };

    test(`is the tunnel when every piece is there`, () => {
        expect(reachPosture(base)).toEqual({ by: `tunnel` });
    });

    test(`is loopback with the reason when a tunnel's piece is missing`, () => {
        expect(reachPosture({ ...base, grant: `` })).toEqual({ by: `loopback`, reason: expect.stringContaining(`SANDBOX_GRANT`) });
        expect(reachPosture({ ...base, url: `` })).toEqual({ by: `loopback`, reason: expect.stringContaining(`INGRESS_URL`) });
        expect(reachPosture({ ...base, frontDoor: false })).toEqual({ by: `loopback`, reason: expect.stringContaining(`front door`) });
    });
});
