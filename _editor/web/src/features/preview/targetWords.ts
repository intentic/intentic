import type { Loaded } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import type { PreviewTarget } from "../../models/preview/previewModel";

// How a live app reads where it is listed: its state in words, the colour its glyph wears, and what the list says when
// it has no app to offer.

// The app's state, as its row says it.
export const stateOf = (target: PreviewTarget): string =>
    target.kind === `repo` || target.kind === `app`
        ? target.healthy
            ? t(`preview.previewPanel.stateRunning`)
            : target.running
              ? t(`preview.previewPanel.stateStarting`)
              : t(`preview.previewPanel.stateStopped`)
        : t(`preview.previewPanel.stateLive`);
// The colour an app's glyph wears: answering, on its way, or down. Anything without a process (a port, the outbox page)
// is answering by being listed.
export const tintOf = (target: PreviewTarget | undefined): string =>
    target === undefined ? `text-subtle` : target.healthy ? `text-success` : target.running ? `text-info` : `text-subtle`;

// What the app list says with nothing to offer: its failure, that nothing runs yet, or that it is still being read.
export const noAppsLine = (listed: Loaded<unknown>): string =>
    listed.state === `failed`
        ? listed.error
        : listed.state === `ready`
          ? t(`preview.previewPanel.startDevServerIn`)
          : t(`preview.previewPanel.readingWhatPreviewed`);
