import { describe, it, expect } from "bun:test";
import { loopbackPreviewUrl } from "./previewLane";

// The loopback twin is a pure rewrite of the public address; whether it answers is the probe's business.

describe(`loopbackPreviewUrl`, () => {
    it(`puts the preview label on a .localhost name at the loopback lane's port, keeping path and query`, () => {
        expect(loopbackPreviewUrl(`https://port-a1b2c3d4e5f6-abcdef012345.sbx.example.test/editor?s=t`, `http://127.0.0.1:30559`, true)).toBe(
            `http://port-a1b2c3d4e5f6-abcdef012345.localhost:30559/editor?s=t`,
        );
        expect(loopbackPreviewUrl(`https://preview-web-abcdef012345.sbx.example.test/`, `https://abcdef012345.local.example.test:30559`, true)).toBe(
            `http://preview-web-abcdef012345.localhost:30559/`,
        );
    });

    it(`answers nothing off the loopback lane, without a lane, or for an address that is not a preview`, () => {
        const url = `https://port-a1b2c3d4e5f6-abcdef012345.sbx.example.test/`;
        expect(loopbackPreviewUrl(url, `http://127.0.0.1:30559`, false)).toBeUndefined();
        expect(loopbackPreviewUrl(url, undefined, true)).toBeUndefined();
        expect(loopbackPreviewUrl(`https://sandbox-abcdef012345.sbx.example.test/health`, `http://127.0.0.1:30559`, true)).toBeUndefined();
        expect(loopbackPreviewUrl(`http://localhost:3000`, `http://127.0.0.1:30559`, true)).toBeUndefined();
        expect(loopbackPreviewUrl(`not a url`, `http://127.0.0.1:30559`, true)).toBeUndefined();
    });

    it(`fills in the scheme's default port when the lane names none`, () => {
        expect(loopbackPreviewUrl(`https://port-x-abcdef012345.sbx.example.test/`, `https://abcdef012345.local.example.test`, true)).toBe(
            `http://port-x-abcdef012345.localhost:443/`,
        );
    });
});
