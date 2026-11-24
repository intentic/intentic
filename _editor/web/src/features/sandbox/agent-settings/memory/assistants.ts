import type { ProviderBrand } from "@intentic/constants";

// The assistants people most often keep a memory of themselves in, as a tile each in the import dialog: its mark (the
// app's own provider marks, so nothing is fetched to draw them) and where a new chat starts. Where the assistant reads a
// question from its address, the export prompt rides along and the chat opens already asked; the prompt is copied on
// every press as well, so one that does not (Gemini) takes a paste.

export interface Assistant {
    readonly id: string;
    readonly name: string;
    readonly brand: ProviderBrand;
    readonly chat: (prompt: string) => string;
}

const asked = (base: string) => (prompt: string) => `${base}?q=${encodeURIComponent(prompt)}`;

export const ASSISTANTS: readonly Assistant[] = [
    // OpenAI's mark, which Codex wears too.
    { id: `chatgpt`, name: `ChatGPT`, brand: `codex`, chat: asked(`https://chatgpt.com/`) },
    { id: `claude`, name: `Claude`, brand: `claude`, chat: asked(`https://claude.ai/new`) },
    { id: `gemini`, name: `Gemini`, brand: `gemini`, chat: () => `https://gemini.google.com/app` },
    { id: `grok`, name: `Grok`, brand: `grok`, chat: asked(`https://grok.com/`) },
];
