import sharp from "sharp";
import { decodeImage, rotateHalfTurn } from "./raster.js";

// Decoding what the reader reads: the first frame of an animation, and how many frames there were, since the frames it
// never read are as able to carry text as the one it did.

const frame = (shade: number): Promise<Buffer> =>
    sharp({ create: { width: 8, height: 6, channels: 3, background: { r: shade, g: shade, b: shade } } })
        .png()
        .toBuffer();

test("an animation decodes to its first frame, and says how many it has", async () => {
    const gif = await sharp([await frame(255), await frame(0)], { join: { animated: true } })
        .gif()
        .toBuffer();
    const image = await decodeImage(gif);
    expect(image).toMatchObject({ format: "gif", frames: 2, rgba: { width: 8, height: 6 } });
    // The first frame, white, not the two stacked.
    expect(image?.rgba.data[0]).toBe(255);
    expect((await decodeImage(await frame(128)))?.frames).toBe(1);
});

test("a half turn puts every pixel where the picture turned upside down has it", () => {
    // 3 x 2, one channel: 1 2 3 / 4 5 6.
    const turned = rotateHalfTurn({ width: 3, height: 2, channels: 1, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) });
    expect(turned).toEqual({ width: 3, height: 2, channels: 1, data: Uint8Array.from([6, 5, 4, 3, 2, 1]) });
});
