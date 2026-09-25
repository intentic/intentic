// TypeScript 6 turns on `noUncheckedSideEffectImports` by default, so a bare `import "pkg/style.css"` has to resolve to
// a declaration. Apps get one from `vite/client`, but the UI kit carries no vite dependency and every package that
// type-checks it from source (extension-ui, the extensions) would need its own copy, so the Vue base config lists this
// one in `files` and every Vue project inherits it.
declare module "*.css";
