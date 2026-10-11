import { nativeSwipeBack } from "./edgeBack";

// Pins where the page's own edge swipe stands down: wherever the browser already draws one (Safari on an iPhone or an
// iPad, an iPad's desktop-class Safari included), so one finger is never answered twice. A home-screen app and the iOS
// shell's web view have no back swipe of their own, and Android's back edge is the system's, which takes the touch.

const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1`;
const IPAD_DESKTOP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15`;
const ANDROID = `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36`;

describe(`the browser's own back swipe`, () => {
    it(`is Safari's on an iPhone or an iPad, so the page leaves the edge to it`, () => {
        expect(nativeSwipeBack(IPHONE, false, false, false)).toBe(true);
        expect(nativeSwipeBack(IPAD_DESKTOP, true, false, false)).toBe(true);
    });

    it(`is absent from a home-screen app, the iOS shell, Android and a desktop`, () => {
        expect(nativeSwipeBack(IPHONE, false, true, false)).toBe(false);
        expect(nativeSwipeBack(IPHONE, false, false, true)).toBe(false);
        expect(nativeSwipeBack(ANDROID, false, false, false)).toBe(false);
        expect(nativeSwipeBack(IPAD_DESKTOP, false, false, false)).toBe(false);
    });
});
