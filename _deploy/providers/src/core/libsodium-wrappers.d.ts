// Ambient type shim for the optional libsodium-wrappers dependency. This package is only needed at runtime
// when setting GitHub Actions secrets (sealed-box encryption). Typed as `any` because the real types are
// installed only when the user adds the package.
declare module "libsodium-wrappers" {
    const sodium: any;
    export default sodium;
}
