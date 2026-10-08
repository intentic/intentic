import { DeviceSchema, EmulateMessageSchema, fitScale, phoneFor } from "./emulation.js";

/* How a device is fitted into the live view's picture (VIEW_WIDTH × VIEW_HEIGHT, 1280 × 800), and what the socket
   accepts as one. */

const BOX = { width: 1280, height: 800 };

describe("fitting a device into the picture", () => {
    // An iPhone 14's 390 × 844 is taller than the 800 the picture has: shrunk so all of it shows, and the size of the
    // picture that leaves is what Chromium's own frames of it measure (370 × 800, measured headless).
    test("a phone taller than the picture is shrunk to its height", () => {
        expect(phoneFor({ width: 390, height: 844, mobile: true }, BOX)).toEqual({
            device: { width: 390, height: 844, mobile: true },
            fit: 800 / 844,
            size: { width: 370, height: 800 },
        });
    });

    test("a device that fits is shown at 1:1, never enlarged", () => {
        expect(fitScale({ width: 360, height: 640 }, BOX)).toBe(1);
        expect(phoneFor({ width: 360, height: 640, mobile: true }, BOX).size).toEqual({ width: 360, height: 640 });
    });

    test("a device wider than the picture is shrunk to its width", () => {
        expect(phoneFor({ width: 2560, height: 1000, mobile: false }, BOX)).toMatchObject({ fit: 0.5, size: { width: 1280, height: 500 } });
    });

    test("a smaller box shrinks it further", () => {
        expect(phoneFor({ width: 390, height: 844, mobile: true }, { width: 1280, height: 422 })).toMatchObject({ fit: 0.5, size: { width: 195, height: 422 } });
    });
});

describe("what an emulate may say", () => {
    test("a device with its size, mobile and an optional user agent, or no device at all", () => {
        expect(EmulateMessageSchema.safeParse({ type: "emulate" }).success).toBe(true);
        expect(EmulateMessageSchema.safeParse({ type: "emulate", device: { width: 390, height: 844, mobile: true } }).success).toBe(true);
        expect(EmulateMessageSchema.safeParse({ type: "emulate", device: { width: 390, height: 844, mobile: true, userAgent: "Phone/1" } }).success).toBe(true);
    });

    test("a size that is not a whole positive number of pixels, a missing flag or an empty user agent is refused", () => {
        expect(DeviceSchema.safeParse({ width: 390.5, height: 844, mobile: true }).success).toBe(false);
        expect(DeviceSchema.safeParse({ width: 0, height: 844, mobile: true }).success).toBe(false);
        expect(DeviceSchema.safeParse({ width: "390", height: 844, mobile: true }).success).toBe(false);
        expect(DeviceSchema.safeParse({ width: 390, height: 844 }).success).toBe(false);
        expect(DeviceSchema.safeParse({ width: 390, height: 844, mobile: true, userAgent: "" }).success).toBe(false);
        expect(EmulateMessageSchema.safeParse({ type: "emulate", device: null }).success).toBe(false);
    });
});
