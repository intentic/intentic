import { openInAppTarget } from "./open-in-app.js";

// A person who opens the sandbox's own address lands in the app on it; nothing else is redirected.
describe("openInAppTarget", () => {
    const config = { webOrigin: "https://app.intentic.dev", sandbox: { publicUrl: "https://sandbox-82789f4106b4.sbx.intentic.dev" } } as const;
    const navigation = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

    it("sends a browser's navigation to the app's /open on this sandbox", () => {
        expect(openInAppTarget(config, navigation)).toBe("https://app.intentic.dev/open?url=https%3A%2F%2Fsandbox-82789f4106b4.sbx.intentic.dev");
    });

    it("names the first origin the app is served to when several are allowed", () => {
        expect(openInAppTarget({ ...config, webOrigin: " https://localhost:47145 , https://app.intentic.dev" }, navigation)).toBe(
            "https://localhost:47145/open?url=https%3A%2F%2Fsandbox-82789f4106b4.sbx.intentic.dev",
        );
    });

    it("redirects nothing but a navigation: an API client keeps its 401", () => {
        expect(openInAppTarget(config, "application/json")).toBeUndefined();
        expect(openInAppTarget(config, undefined)).toBeUndefined();
    });

    it("redirects nowhere for a sandbox with no public address", () => {
        expect(openInAppTarget({ ...config, sandbox: { publicUrl: "" } }, navigation)).toBeUndefined();
    });
});
