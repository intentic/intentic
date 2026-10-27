import type { GroupSamples } from "./context.ts";

// Storybook given an address, then taken off again; the previews guarded for members and opened again to anyone.
export const portsSamples: GroupSamples<`ports`> = () => ({
    list: undefined,
    forward: { port: 6006 },
    unforward: { port: 6006 },
    previewGuard: undefined,
    setPreviewGuard: { scope: `panels` },
    previewPass: { url: `https://preview-web-demo.demo.invalid/` },
});
