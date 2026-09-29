import { pushUnsupportedReason } from "./pushAdvice";

// Settings ▸ Notifications told a Linux desktop app's reader to add the app to their Home Screen in Safari.

const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1`;
const IPAD_AS_MAC = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15`;
const LINUX_WEBVIEW = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)`;

const reason = (userAgent: string, over: { desktopApp?: boolean; standalone?: boolean; maxTouchPoints?: number } = {}) =>
    pushUnsupportedReason({ userAgent, desktopApp: false, standalone: false, maxTouchPoints: 0, ...over });

it(`sends an iPhone or iPad browser to the Home Screen, where push works`, () => {
    expect([reason(IPHONE), reason(IPAD_AS_MAC, { maxTouchPoints: 5 })]).toEqual([`home-screen`, `home-screen`]);
});

it(`says nothing of the Home Screen to the desktop app, a Mac, or an app already opened from there`, () => {
    expect([
        reason(LINUX_WEBVIEW, { desktopApp: true }),
        reason(IPAD_AS_MAC),
        reason(IPHONE, { standalone: true }),
        reason(LINUX_WEBVIEW),
    ]).toEqual([`desktop-app`, `browser`, `browser`, `browser`]);
});
