import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";

// Registers viewers for non-source file formats; each is pure render, given `text`, `blob`, or a streaming `src` per
// its manifest entry. Viewer ids must match an approved manifest declaration.
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
