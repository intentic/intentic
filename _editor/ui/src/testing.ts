import { defineComponent, h } from "vue";

// Canonical `Icon` stand-in for component tests, since Icon is registered globally and an unmounted name fails the
// render. Renders `data-icon`/`data-spin`, not a CSS spin class: the real Icon animates via SVG honoring
// prefers-reduced-motion, and reducedMotion.test.ts bans CSS motion in app/kit source.
export const IconStub = defineComponent({
    name: `Icon`,
    props: { name: { type: String, default: `` }, spin: Boolean },
    setup: (props) => () => h(`i`, { "data-icon": props.name, ...(props.spin ? { "data-spin": `` } : {}) }),
});
