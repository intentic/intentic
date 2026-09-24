import { reachPosture, tunnelUrl } from "./reach-posture.js";

describe(`tunnelUrl`, () => {
    test(`derives the versioned websocket door from the edge's https address`, () => {
        expect(tunnelUrl(`https://ingress.sbx.intentic.dev`)).toBe(`wss://ingress.sbx.intentic.dev/tunnel/v1`);
    });

    test(`keeps a plaintext edge plaintext`, () => {
        expect(tunnelUrl(`http://localhost:8080`)).toBe(`ws://localhost:8080/tunnel/v1`);
    });

    test(`ignores a path on the base address`, () => {
        expect(tunnelUrl(`https://edge.example.test/ignored`)).toBe(`wss://edge.example.test/tunnel/v1`);
    });
});

describe(`reachPosture`, () => {
    const base = { url: `https://ingress.example.test`, grant: `ig1.a.b`, frontDoor: true, vm: false };

    test(`is the tunnel when every piece is there`, () => {
        expect(reachPosture(base)).toEqual({ by: `tunnel` });
    });

    test(`is direct on a Fly machine, whatever else is configured`, () => {
        expect(reachPosture({ ...base, vm: true }).by).toBe(`direct`);
        expect(reachPosture({ ...base, vm: true, grant: `` }).by).toBe(`direct`);
    });

    test(`is loopback with the reason when a tunnel's piece is missing`, () => {
        expect(reachPosture({ ...base, grant: `` })).toEqual({ by: `loopback`, reason: expect.stringContaining(`SANDBOX_GRANT`) });
        expect(reachPosture({ ...base, url: `` })).toEqual({ by: `loopback`, reason: expect.stringContaining(`INGRESS_URL`) });
        expect(reachPosture({ ...base, frontDoor: false })).toEqual({ by: `loopback`, reason: expect.stringContaining(`front door`) });
    });
});
