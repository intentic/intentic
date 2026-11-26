import { extensionIdOf } from "@intentic/extension-manifest";
import { manifest } from "./manifest.js";

// The snippet a customer pastes to put a Visitor chat on their site: the widget from this extension's public door, on
// the sandbox's own origin, which the widget also talks to. Only the chat's id is needed; its allowed sites decide who
// may use it. A snippet from before 2026-11-26 names /webchat/widget.js, which the daemon forwards here.
export const WIDGET_PATH = `/door/${extensionIdOf(manifest)}/widget.js`;

export const embedSnippet = (origin: string, automationId: string): string => `<script src="${origin}${WIDGET_PATH}" data-automation="${automationId}" defer></script>`;
