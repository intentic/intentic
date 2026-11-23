import { desktopBundleOnLoopback } from "../browser-origins.js";
import { LOOPBACK_LISTENER, PARENT_LISTENER } from "./listener.js";
import { assertChannel } from "./proof-methods.js";

// A runner's netd marks what its parent carried down the uplink `parent` (netd proxy.rs `stamp_listener`): never the
// machine's own loopback, so nothing a loopback request may do follows from it.
describe("a request from a runner's parent", () => {
    test("is not the loopback port: the host proof is refused on it", () => {
        expect(() => assertChannel(["host"], LOOPBACK_LISTENER)).not.toThrow();
        expect(() => assertChannel(["host"], PARENT_LISTENER)).toThrow("loopback port");
        expect(() => assertChannel(["passkey"], PARENT_LISTENER)).not.toThrow();
    });

    test("does not admit the desktop app's bundled page", () => {
        expect(desktopBundleOnLoopback("tauri://localhost", LOOPBACK_LISTENER)).toBe(true);
        const origins = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
        expect(origins.some((origin) => desktopBundleOnLoopback(origin, PARENT_LISTENER))).toBe(false);
    });
});
