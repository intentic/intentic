import type { PreviewDeps } from "../panels/preview-routes.js";
import { frontDoorServer } from "./front-door.js";

describe(`the front door's HTTP server`, () => {
    // A stall past a keep-alive timer let Node close a pooled socket the front had just written a request into; the
    // front answered that request 502 (reproduced with a 5 s timer and an 8 s stall ending in the check phase).
    it(`leaves idleness and pace to the front, keeping no timer of its own`, () => {
        const server = frontDoorServer({} as PreviewDeps, { warn: () => undefined })({}, () => undefined);
        expect(server.keepAliveTimeout).toBe(0);
        expect(server.requestTimeout).toBe(0);
    });
});
