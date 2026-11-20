import { tunnelDoor } from "./edge.js";

// The edge's own door, read off netd's remembered config: the origin its tunnel dials, as https.

it("reads the door off the tunnel netd dials", () => {
    expect(tunnelDoor(JSON.stringify({ listen: {}, tunnel: { url: "wss://ingress.example.test/tunnel/v2", grant: "g" } }))).toBe("https://ingress.example.test");
    expect(tunnelDoor(JSON.stringify({ tunnel: { url: "ws://127.0.0.1:8080/tunnel/v2" } }))).toBe("http://127.0.0.1:8080");
});

it("names no door for a config with no tunnel, or one that is not netd's", () => {
    expect(tunnelDoor(JSON.stringify({ listen: {} }))).toBeUndefined();
    expect(tunnelDoor("not json")).toBeUndefined();
    expect(tunnelDoor(JSON.stringify({ tunnel: { url: "not a url" } }))).toBeUndefined();
});
