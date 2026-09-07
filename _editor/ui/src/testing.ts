import { defineComponent, h } from "vue";

/* THE KIT'S OWN STAND-INS, so a suite that mounts a view does not have to invent them.
 *
 * `Icon` is registered globally by the app (main.ts), so every component test that mounts anything with a
 * glyph in it has to register something for that name or Vue warns and the render fails. Eighty-six suites did,
 * and they had drifted into SIXTEEN spellings: `{ render: () => null }`, `defineComponent({ props: { name:
 * String }, render: () => h('i') })`, a `<span />` template, four combinations of `name`/`spin`, two ways of
 * reaching the props (`this` vs a `setup` closure), and two of those emitted `data-icon` while the rest did not.
 *
 * That is what one fake per suite costs. A suite asserting on `[data-icon]` passed or failed depending on
 * which copy its author started from, and a change to the real `Icon`'s props could not be reflected in the
 * fakes because there was no fake to change — there were sixteen. So: one, here, beside the component it
 * stands in for, and every suite imports it.
 *
 * IT RENDERS, and renders both props. The stand-in is a superset of what the sixteen did: an `<i>` carrying
 * `data-icon` and `data-spin`, which is what the loudest of them did and what a suite has to have if it is ever
 * to assert WHICH glyph a row drew, or whether it drew a busy one. A suite that does not care never looks.
 *
 * `data-spin` rather than the CSS spin utility three of the copies reached for: the real Icon does not spin
 * with a class — it runs an SVG animation whose duration answers `prefers-reduced-motion` — so a suite
 * asserting on that class was asserting a property of its own fake. It is also a utility the app is not
 * allowed to write at all (reducedMotion.test.ts refuses request-driven CSS motion anywhere in app or kit
 * source, by scanning for it), and a fixture is not an exemption from a rule discovered by shape. */
export const IconStub = defineComponent({
    name: `Icon`,
    props: { name: { type: String, default: `` }, spin: Boolean },
    setup: (props) => () => h(`i`, { "data-icon": props.name, ...(props.spin ? { "data-spin": `` } : {}) }),
});
