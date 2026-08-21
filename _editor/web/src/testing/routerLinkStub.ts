import { defineComponent, h, type PropType } from "vue";

/* A <RouterLink> FOR A COMPONENT TEST THAT MOUNTS NO ROUTER.
 *
 * Every navigational row in this app is a real link, which means a lot of components now import RouterLink:
 * and the real one resolves its href out of the router INJECTED by `app.use(router)`. A unit test that mounts
 * one component into a bare app has no such router, so the real link throws on its first render and takes the
 * whole suite's mount with it.
 *
 * Installing a router in each of those tests would be the wrong trade: they mock `useRouter` precisely so a
 * navigation is a spy rather than a real one, and a half-real router beside a mocked one is two answers to
 * "where did that go".
 *
 * So: an anchor that carries the address and nothing else. It keeps the `href` on purpose, WHERE a row goes
 * is the thing worth asserting, and a stub that dropped it would let a link pointing at the wrong page pass.
 *
 * Spread it into the module mock beside the rest:
 *
 *     vi.mock(import(`vue-router`), async (importOriginal) => ({
 *         ...(await importOriginal()),
 *         useRouter: () => ({ push }) as never,
 *         RouterLink: RouterLinkStub as never,
 *     }));
 */
export const RouterLinkStub = defineComponent({
    name: `RouterLink`,
    props: {
        to: { type: [String, Object] as PropType<string | Record<string, unknown>>, required: true },
    },
    setup(props, { slots }) {
        // Only a string `to` has an address without a router to resolve it. A location object renders as a
        // link with no href, which is exactly what it is here: present, inert, and not claiming otherwise.
        return () => h(`a`, typeof props.to === `string` ? { href: props.to } : {}, slots[`default`]?.());
    },
});
