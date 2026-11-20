import type { BrowserContext, Page } from "playwright";
import { type Device, EmulateMessageSchema } from "./emulation.js";
import type { ScreencastClientMessage } from "./screencast.js";
import { stopLoading } from "../navigation/page-navigation.js";

// What every live view does with the browser as a program, whichever way its picture travels (live-view.ts,
// media-view.ts): addresses, history, new tabs and the device asked for.

// The device an emulate asks for, undefined to take it off, or "invalid" for a frame of any other shape, which is dropped.
export const askedDevice = (message: ScreencastClientMessage): Device | undefined | "invalid" => {
    const parsed = EmulateMessageSchema.safeParse(message);
    return parsed.success ? parsed.data.device : "invalid";
};

export type Steer = Extract<ScreencastClientMessage, { type: "navigate" | "back" | "forward" | "reload" | "stop" }>;

const STEERS: ReadonlySet<string> = new Set<Steer["type"]>(["navigate", "back", "forward", "reload", "stop"]);
export const isSteer = (message: ScreencastClientMessage): message is Steer => STEERS.has(message.type);

// Not awaited past the commit and never past an error: Chromium shows its own error page for a bad address, and a
// slow site must not hold the socket's handler.
export const steer = (page: Page | undefined, message: Steer): void => {
    if (page === undefined) {
        return;
    }
    const swallow = (): undefined => undefined;
    switch (message.type) {
        case "navigate":
            void page.goto(message.url, { waitUntil: "commit" }).catch(swallow);
            return;
        case "back":
            void page.goBack({ waitUntil: "commit" }).catch(swallow);
            return;
        case "forward":
            void page.goForward({ waitUntil: "commit" }).catch(swallow);
            return;
        case "reload":
            void page.reload({ waitUntil: "commit" }).catch(swallow);
            return;
        case "stop":
            void stopLoading(page).catch(swallow);
            return;
    }
};

// A tab the owner asked for, at the address they typed if any; undefined when the browser is gone.
export const openTab = async (context: BrowserContext, url: string | undefined): Promise<Page | undefined> => {
    // allow(silent-catch): a browser closing as the tab is asked for opens none, which the caller is told as undefined.
    const page = await context.newPage().catch(() => undefined);
    if (page !== undefined && url !== undefined) {
        steer(page, { type: "navigate", url });
    }
    return page;
};
