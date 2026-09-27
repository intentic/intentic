import { type Device, parseHostConnection } from "@intentic/sandbox-contract";

// A device row as a current daemon lists it: a row with a host key names the card that key is of beside it
// (device-reports.ts), which the editor reads and never parses back out of the key. A suite that writes only the key
// gets the card the daemon would have sent, by the one parser there is; a row naming its own card keeps it.
export const listedDevice = (device: Device): Device =>
    device.hostId === undefined || device.card !== undefined ? device : { ...device, card: parseHostConnection(device.hostId).card };
