# THE CHECKOUT THIS SCRIPT WAS RUN OUT OF, or empty when there is none, which is the normal case: the piped
# `curl … | sh` form has no path in $0 at all. Found by walking up to the workspace marker rather than counting levels,
# so it is right wherever the file is served from; every use still GATES on finding the specific file it needs.
checkout_root() {
    case "$0" in
        */*) _dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || return 0 ;;
        *) return 0 ;; # piped curl|sh: no path, no checkout
    esac
    while [ -n "$_dir" ] && [ "$_dir" != "/" ]; do
        if [ -f "$_dir/pnpm-workspace.yaml" ]; then
            printf '%s\n' "$_dir"
            return 0
        fi
        _dir="$(dirname "$_dir")"
    done
}

# ic_from_checkout: run BY PATH from a checkout (the dev platform's one-liners, a hand-run in the repo), prefer the
# checkout's OWN ic: a flow change and its CLI change land in one commit and are tested together, and a released ic may
# predate both. Sets $IC when it built one; IC_BIN, the piped form and a checkout without cargo skip it.
ic_from_checkout() {
    IC="${IC:-${IC_BIN:-}}"
    [ -z "$IC" ] || return 0
    CHECKOUT="$(checkout_root)"
    [ -n "$CHECKOUT" ] || return 0
    ic_manifest="$CHECKOUT/_sandbox/ic/Cargo.toml"
    if [ -f "$ic_manifest" ] && command -v cargo >/dev/null 2>&1; then
        kit_step fetching-ic "building the checkout's ic CLI…" "Build ic from the checkout"
        kit_suspend
        if cargo build --quiet --manifest-path "$ic_manifest"; then
            IC="$CHECKOUT/_sandbox/ic/target/debug/ic"
        else
            kit_warn "the checkout's ic did not build, so the released ic runs instead."
        fi
        kit_resume
        kit_settle
    fi
}
