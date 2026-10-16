import { keysUrlOf } from "./keyring-fetch.js";

test("the keys are fetched over HTTP(S) from the sandbox's own host, whatever address the link dials", () => {
    expect(keysUrlOf("wss://a1b2c3d4e5f6.intentic.dev/system/hosts/connect").href).toBe("https://a1b2c3d4e5f6.intentic.dev/keyring/keys");
    expect(keysUrlOf("https://a1b2c3d4e5f6.intentic.dev").href).toBe("https://a1b2c3d4e5f6.intentic.dev/keyring/keys");
    expect(keysUrlOf("ws://localhost:4310").href).toBe("http://localhost:4310/keyring/keys");
});
