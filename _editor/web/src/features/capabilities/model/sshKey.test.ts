import { CAPABILITY_CATALOG } from "@intentic/capability-catalog";
import { authorizeCommand, generatesKey } from "./sshKey";

const ssh = CAPABILITY_CATALOG.find((entry) => entry.id === `ssh`)!;
const vpn = CAPABILITY_CATALOG.find((entry) => entry.id === `vpn`)!;
const privateKeyFields = ssh.fields.filter((field) => field.key === `privateKey`);

it(`stands in for the private key only while the sandbox is to make it`, () => {
    for (const field of privateKeyFields) {
        expect(generatesKey(ssh, field, { auth: `generated` })).toBe(true);
        expect(generatesKey(ssh, field, { auth: `key` })).toBe(false);
    }
    expect(generatesKey(ssh, ssh.fields.find((field) => field.key === `host`)!, { auth: `generated` })).toBe(false);
    // Another tile's field of the same name is none of its business.
    expect(generatesKey(vpn, { key: `privateKey`, label: `Key` }, { auth: `generated` })).toBe(false);
});

it(`authorizes the key for whoever runs it, on an account that has no ~/.ssh yet`, () => {
    expect(authorizeCommand(`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTv intentic-box\n`)).toBe(
        `mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTv intentic-box' >> ~/.ssh/authorized_keys`,
    );
});

// A pasted key's comment is whatever its maker typed; a bare quote there would end the shell word early.
it(`keeps a quote in the key's comment inside the shell word`, () => {
    expect(authorizeCommand(`ssh-ed25519 AAAA ada's laptop`)).toBe(`mkdir -p ~/.ssh && echo 'ssh-ed25519 AAAA ada'\\''s laptop' >> ~/.ssh/authorized_keys`);
});
