import { answeringFetch, streamedResponse } from "../../http/fetch.testing.js";
import { fetchRemoteImage } from "./request-shield.js";

const MIB = 1024 * 1024;
const PNG = { headers: { "content-type": "image/png" } };

describe("fetchRemoteImage", () => {
    it("refuses a picture past its cap that declares no length, without reading it all", async () => {
        // 64 MiB offered in 1 MiB chunks; the cap is 20 MiB.
        const { response, pulled } = streamedResponse(64, MIB, 0x89, PNG);

        expect(await fetchRemoteImage("https://img.example.com/huge.png", answeringFetch(() => response))).toBeUndefined();
        expect(pulled.cancelled).toBe(true);
        expect(pulled.count).toBeLessThanOrEqual(22);
    });

    it("carries a picture under the cap as base64", async () => {
        const { response } = streamedResponse(2, 3, 0x41, { headers: { "content-type": "image/png; charset=binary" } });

        expect(await fetchRemoteImage("https://img.example.com/a.png", answeringFetch(() => response))).toEqual({ mediaType: "image/png", data: "QUFBQUFB" });
    });
});
