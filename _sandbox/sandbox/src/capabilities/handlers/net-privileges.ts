/* THE ONE BLOCK THAT ASKS FOR A TUN DEVICE, shared verbatim by every kind that builds tunnels.
 *
 * Fragments are deduped by EXACT CONTENT when the overlay is composed (environment.ts). So two kinds that
 * each need /dev/net/tun and NET_ADMIN must contribute the identical string, or both survive the dedupe and
 * the recreate hands `docker run` the same `--device` twice, which fails the launch outright. A `vpn` and an
 * `exit` capability in one sandbox is not an exotic combination, it is the expected one: reach the office
 * network, and read a page as a German visitor.
 *
 * Hence this file. The kinds install their own clients in their own fragments (which differ, and should) and
 * both point at this for the privilege (which must not). Changing a byte here changes it for every kind at
 * once, which is the property that makes the dedupe safe.
 *
 * Nothing else belongs in here. It is a privilege request, not a place to put shared packages: a package added
 * here would be installed on behalf of a kind that never asked for it, and would make the block's content a
 * function of the other kind's needs.
 */
export const TUN_PRIVILEGES_FRAGMENT = `# The container privileges every tunnel-building capability shares: a tun device to route over and the
# capability to configure it. Contributed identically by vpn and exit (see handlers/net-privileges.ts), which
# is what keeps the composed overlay from asking docker run for the same device twice.
# intentic:runtime --device=/dev/net/tun
# intentic:runtime --cap-add=NET_ADMIN`;
