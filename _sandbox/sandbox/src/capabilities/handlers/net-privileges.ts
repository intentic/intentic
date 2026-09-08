// The one tun-device privilege block, shared verbatim by every tunnel-building kind (vpn, exit): fragments dedupe by
// exact content when composed, so a byte of drift here would let both survive and hand docker run the same --device
// twice. Nothing else belongs here, only the privilege request, never a shared package.
export const TUN_PRIVILEGES_FRAGMENT = `# The container privileges every tunnel-building capability shares: a tun device to route over and the
# capability to configure it. Contributed identically by vpn and exit (see handlers/net-privileges.ts), which
# is what keeps the composed overlay from asking docker run for the same device twice.
# intentic:runtime --device=/dev/net/tun
# intentic:runtime --cap-add=NET_ADMIN`;
