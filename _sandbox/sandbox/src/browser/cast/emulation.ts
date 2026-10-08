import type { CDPSession, Page } from "playwright";
import { z } from "zod";
import { VIEW_HEIGHT, VIEW_WIDTH } from "./screencast.js";

/* A phone on the live view (live-view.ts): the owner asks for the page they are looking at to render as a device, and
   the view puts that device on whatever page it shows until they ask for it off or close the socket. One socket's
   choice, never the browser's: the agent's own later use of the page must not find it still dressed as a phone.

   The device is CDP's device metrics (its CSS size, and `mobile` for the meta viewport and overlay scrollbars), touch
   support, and a user agent when one is given; its pixel ratio is left as the display's. A phone is taller than the
   picture has room for (844 CSS px against 800), so it is shrunk to fit whole, by the override's own `scale`: Chromium
   draws the shrunk device at the top-left of the viewport and maps input through the same scale, so a click on the
   picture still lands on what it was aimed at. */

// The client's ask, read at the socket: the routes hand messages over unchecked, so this is where an emulate is checked.
export const DeviceSchema = z.object({
    width: z.number().int().min(1).max(10_000),
    height: z.number().int().min(1).max(10_000),
    mobile: z.boolean(),
    userAgent: z.string().min(1).max(2_048).optional(),
});

export type Device = z.infer<typeof DeviceSchema>;

export const EmulateMessageSchema = z.object({ type: z.literal("emulate"), device: DeviceSchema.optional() });

export interface Size {
    readonly width: number;
    readonly height: number;
}

// The box a device is fitted into: the frames path's fixed picture, which the video path keeps to as well.
export const PHONE_BOX: Size = { width: VIEW_WIDTH, height: VIEW_HEIGHT };

// A device as the view wears it: how far it is shrunk, and the size of the picture that leaves, in CSS px.
export interface Phone {
    readonly device: Device;
    readonly fit: number;
    readonly size: Size;
}

// How far a device is shrunk to fit the box whole; never enlarged, since a small device at 1:1 is already all there.
export const fitScale = (device: Size, box: Size): number => Math.min(1, box.width / device.width, box.height / device.height);

// The device fitted into the box. Its size is rounded as Chromium rounds the frames it draws of it, so the picture and
// the frames agree to the pixel.
export const phoneFor = (device: Device, box: Size): Phone => {
    const fit = fitScale(device, box);
    return { device, fit, size: { width: Math.max(1, Math.round(device.width * fit)), height: Math.max(1, Math.round(device.height * fit)) } };
};

// Dresses one page as the phone. A second call replaces the first whole, user agent included: a device without one
// takes back the browser's own.
export const putPhoneOn = async (session: CDPSession, phone: Phone): Promise<void> => {
    await session.send("Emulation.setDeviceMetricsOverride", {
        width: phone.device.width,
        height: phone.device.height,
        // 0 is no override: the display's own pixel ratio, which is what the picture is grabbed at.
        deviceScaleFactor: 0,
        mobile: phone.device.mobile,
        scale: phone.fit,
    });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    // An empty user agent is CDP's "no override".
    await session.send("Emulation.setUserAgentOverride", { userAgent: phone.device.userAgent ?? "" });
};

// Undresses it. Explicitly, never by detaching: a page keeps a session's overrides after that session has gone
// (measured on Chromium 1243, 2026-10-08). And Chromium holds one set of metrics per page whoever set them, so clearing
// the phone also cleared any size Playwright had set on the page (the frames path's fixed viewport): Playwright is asked
// to set it again, by way of another size first, since it skips a size it believes is already in force.
export const takePhoneOff = async (session: CDPSession, page: Page): Promise<void> => {
    await session.send("Emulation.clearDeviceMetricsOverride");
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await session.send("Emulation.setUserAgentOverride", { userAgent: "" });
    const viewport = page.viewportSize();
    if (viewport !== null) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height + 1 });
        await page.setViewportSize(viewport);
    }
};
