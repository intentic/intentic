// Ambient type shim for the optional libsodium-wrappers dependency. This package is only needed at runtime
// when setting GitHub Actions secrets (sealed-box encryption). Typed as `any` because the real types are
// installed only when the user adds the package.
declare module "libsodium-wrappers" {
    // oxlint-disable-next-line typescript/no-explicit-any -- libsodium-wrappers ships no types; this shim exists precisely to name the untyped surface once.
    const sodium: any;
    export default sodium;
}
