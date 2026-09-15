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
        // One spreadsheet viewer for both formats: its worker reads the container from the bytes, not the name.
        api.viewers.register({ id: `xlsx`, component: async () => (await import(`./SheetViewer.vue`)).default }),
        api.viewers.register({ id: `pptx`, component: async () => (await import(`./PptxViewer.vue`)).default }),
        api.viewers.register({ id: `odf-text`, component: async () => (await import(`./OdfTextViewer.vue`)).default }),
        api.viewers.register({ id: `odf-slides`, component: async () => (await import(`./OdfSlidesViewer.vue`)).default }),
        api.viewers.register({ id: `rtf`, component: async () => (await import(`./RtfViewer.vue`)).default }),
        api.viewers.register({ id: `epub`, component: async () => (await import(`./EpubViewer.vue`)).default }),
    );
};
