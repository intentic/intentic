import { fleetFrom } from "../sandboxes.js";

const row = { slug: "sandbox-850b3ad46a90", container: "intentic-sandbox-sandbox-850b3ad46a90", running: true, image: "img" };

describe("a listed sandbox's name", () => {
    it("is ic's displayName, so readers see the owner's name rather than only the slug", () => {
        const [read] = fleetFrom(JSON.stringify([{ ...row, displayName: "translations", logo: "data:image/webp;base64,AAAA" }]));
        expect(read?.name).toBe("translations");
        expect(read).not.toHaveProperty("logo");
    });

    it("is left out when ic named nothing, or only whitespace", () => {
        expect(fleetFrom(JSON.stringify([row]))[0]?.name).toBeUndefined();
        expect(fleetFrom(JSON.stringify([{ ...row, displayName: "  " }]))[0]?.name).toBeUndefined();
        expect(fleetFrom(JSON.stringify([{ ...row, displayName: null }]))[0]?.name).toBeUndefined();
    });
});
