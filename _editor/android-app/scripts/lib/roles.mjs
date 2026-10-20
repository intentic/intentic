// The editor's semantic colour roles, evaluated per scheme. `data-mode="dark"` is set on <html>, the element `:root`
// matches too, so both schemes are one element's cascade: the dark block's declarations override the light ones, and a
// `var()` resolves against whichever scheme is being evaluated, as a browser resolves it there.
import { argb } from "./colour.mjs";
import { declarations, evaluate } from "./css.mjs";

const ROLE = /^var\(--role-([\w-]+)\)$/;
const DARK = `[data-mode="dark"]`;

/** `{ light, dark }`, each `[resourceName, "#AARRGGBB"]` pairs in the order the roles are declared. */
export const roleColours = (primitiveCss, semanticCss) => {
    const all = [...declarations(primitiveCss), ...declarations(semanticCss)];
    const light = new Map(all.filter(({ scope }) => scope !== DARK).map(({ name, value }) => [name, value]));
    const dark = new Map([...light, ...all.filter(({ scope }) => scope === DARK).map(({ name, value }) => [name, value])]);
    const roles = declarations(semanticCss).filter(({ scope, name, value }) => scope.startsWith(`@theme`) && name === `--color-${value.match(ROLE)?.[1]}`);
    const scheme = (values) =>
        roles.map(({ name, value }) => {
            try {
                return [name.slice(`--color-`.length).replaceAll(`-`, `_`), argb(evaluate(value, (key) => values.get(key)))];
            } catch (error) {
                throw new Error(`${name}: ${error.message}`, { cause: error });
            }
        });
    return { light: scheme(light), dark: scheme(dark) };
};
