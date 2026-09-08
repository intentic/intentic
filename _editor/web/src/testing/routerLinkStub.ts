import { defineComponent, h, type PropType } from "vue";

// A <RouterLink> stub for a component test that mounts no router: the real link resolves its href from an injected
// router, which throws when none exists. Renders a plain anchor, with `href` set only for a string `to`, so a link
// pointing at the wrong location still fails an assertion on it.
export const RouterLinkStub = defineComponent({
    name: `RouterLink`,
    props: {
        to: { type: [String, Object] as PropType<string | Record<string, unknown>>, required: true },
    },
    setup(props, { slots }) {
        // A string `to` gets an href; an object `to` has none to resolve without a router, so the link renders inert.
        return () => h(`a`, typeof props.to === `string` ? { href: props.to } : {}, slots[`default`]?.());
    },
});
