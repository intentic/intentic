import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";

/* ext-viewers activation: every file format the app can show that isn't source code.
 *
 * This is where "what can this app open?" lives. The core resolves a path to TEXT or to opaque bytes and stops
 * there; each viewer below claims a set of extensions and turns those bytes into something to look at. Switch
 * this extension off and the workspace still opens every file — as a download — which is the honest floor, and
 * the reason none of these ever needed a branch in the core.
 *
 * A viewer is pure render. The host resolves an open file to it, gets the content the way its MANIFEST entry
 * declares, and passes it in: `text` for the SVG's markup, `blob` for the formats that must be parsed whole,
 * `src` (a streaming /workspace/media URL) for audio and video, which are read a window at a time and never
 * held. So none of these components touches the daemon, and none of them ever sees a credential. Each id must
 * match a manifest viewer declaration; the host refuses a registration the approved manifest never named. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    context.subscriptions.push(
        api.viewers.register({ id: `image`, component: async () => (await import(`./ImageFileViewer.vue`)).default }),
        api.viewers.register({ id: `svg`, component: async () => (await import(`./SvgViewer.vue`)).default }),
        api.viewers.register({ id: `pdf`, component: async () => (await import(`./PdfViewer.vue`)).default }),
        api.viewers.register({ id: `media`, component: async () => (await import(`./MediaViewer.vue`)).default }),
        api.viewers.register({ id: `docx`, component: async () => (await import(`./DocxViewer.vue`)).default }),
        api.viewers.register({ id: `xlsx`, component: async () => (await import(`./SheetViewer.vue`)).default }),
    );
};
