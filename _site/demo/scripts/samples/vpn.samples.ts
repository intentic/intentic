import type { GroupSamples } from "./context.ts";

// The office tunnel is dialled and dropped again, so the run ends with it down as it started.
export const vpnSamples: GroupSamples<`vpn`> = () => ({
    list: undefined,
    connect: { id: `office-vpn` },
    disconnect: { id: `office-vpn` },
    importForticlient: {
        xml: `<forticlient_configuration><vpn><sslvpn><connections><connection><name>Office</name><server>vpn.acme.dev:10443</server><username>ada</username></connection></connections></sslvpn></vpn></forticlient_configuration>`,
    },
});
