import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";

/* ext-viewers activation: register the docx + xlsx custom file viewers (contributes.viewers). A viewer is pure
 * render — the host resolves an open file to it, fetches the bytes, and passes them in as `blob`, so these
 * components never touch the daemon and need no host handle. Each id must match a manifest viewer declaration. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    context.subscriptions.push(
        api.viewers.register({ id: `docx`, component: async () => (await import(`./DocxViewer.vue`)).default }),
        api.viewers.register({ id: `xlsx`, component: async () => (await import(`./SheetViewer.vue`)).default }),
    );
};
