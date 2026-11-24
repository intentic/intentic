import { canAnimate, FOLD_EASE, FOLD_MS, lessMotion } from "@intentic/ui/motion";
import { type Ref, watch } from "vue";

// THE CHAT'S COLUMNS MAKE ROOM FOR THE RAIL. The rail (its checklist, then Usage left) arriving narrows each pane by its
// width and the reading column re-centres in what is left; leaving, the column widens back. Drawn at once at its new
// width, the column then slides from where its text started to where it starts now, on the board's own fold (fold.ts),
// rather than jumping sideways under the reader. By the left edge, where every line starts and the eye holds on, so a
// column whose width changed a lot (a drag that ran far past where the rail fits) never slides out past the panel's own
// edge. Measured off each pane's footer, which stands in the column like the transcript above it; the whole of the pane's
// content moves.
export const useRailRoom = (panel: Readonly<Ref<HTMLElement | undefined>>, rail: () => boolean): void => {
    const footers = (): HTMLElement[] => [...(panel.value?.querySelectorAll<HTMLElement>(`.chat-pane [data-lane-floor]`) ?? [])];
    let before: Map<HTMLElement, number> | undefined;
    watch(
        rail,
        () => {
            before = lessMotion() ? undefined : new Map(footers().map((footer) => [footer, footer.getBoundingClientRect().left]));
        },
        { flush: `pre` },
    );
    watch(
        rail,
        () => {
            const was = before;
            before = undefined;
            if (was === undefined) {
                return;
            }
            for (const footer of footers()) {
                const from = was.get(footer);
                const content = footer.parentElement;
                const dx = from === undefined ? 0 : from - footer.getBoundingClientRect().left;
                if (Math.abs(dx) >= 0.5 && canAnimate(content)) {
                    content.animate([{ translate: `${dx}px 0` }, { translate: `0 0` }], { duration: FOLD_MS, easing: FOLD_EASE });
                }
            }
        },
        { flush: `post` },
    );
};
