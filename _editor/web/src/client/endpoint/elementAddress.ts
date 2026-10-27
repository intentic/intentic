// THE ADDRESS A BROWSER ELEMENT LOADS A SANDBOX URL FROM. Everything the editor fetches itself goes through `fetch`,
// which the host's transport can route however it reaches the sandbox. A few sandbox URLs are instead handed to the
// browser: a <video>'s or <img>'s `src`, a frame's `src`, a download link, a tab opened on a served page. The browser
// requests those itself, straight from the address, so a host that reaches its sandbox through a channel elements
// cannot use (an in-page transport, a native bridge, a proxy that needs a header) names a stand-in address for each
// here, one it can serve. Every place that hands a sandbox URL to an element passes it through `elementAddress` last.
//
// The host injects its resolver as `window.__INTENTIC_ELEMENT_ADDRESS__` before the app's entry runs, the way the
// desktop app injects `__INTENTIC_DESKTOP__`. Without one, an address is used as it is, which is every ordinary browser.

/** Turns a sandbox URL an element is about to load into the address it should load instead; answers it unchanged when
 * the element can reach it as it is. Synchronous, since it sits between a computed value and an element's attribute. */
export type ElementAddressResolver = (url: string) => string;

declare global {
    interface Window {
        __INTENTIC_ELEMENT_ADDRESS__?: ElementAddressResolver;
    }
}

/** The address to hand an element for `url`: the host's stand-in where it names one, else `url` itself. */
export const elementAddress = (url: string): string => globalThis.window?.__INTENTIC_ELEMENT_ADDRESS__?.(url) ?? url;
