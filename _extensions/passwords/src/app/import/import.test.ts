import { parseCsv } from "./csv.js";
import { originOfUrl, parseImport } from "./formats.js";

// Each exporter's file as it really writes it (headers copied from each one's own export), read into the rows the
// keyring is sent: told apart by header alone, every login with a place and a password kept, everything else counted.

describe(`parseCsv`, () => {
    it(`reads quoted commas, doubled quotes, line breaks inside a cell, CRLF and a byte-order mark`, () => {
        expect(parseCsv(`﻿a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n\r\n`)).toEqual([
            [`a`, `b`],
            [`x, y`, `say "hi"`],
            [`two\nlines`, `z`],
        ]);
    });
});

describe(`originOfUrl`, () => {
    it(`takes a site by its host, an Android app by its package, and nothing from what is neither`, () => {
        expect(originOfUrl(`https://www.GitHub.com/login?x=1`)).toEqual({ kind: `site`, host: `github.com` });
        expect(originOfUrl(`accounts.google.com`)).toEqual({ kind: `site`, host: `accounts.google.com` });
        expect(originOfUrl(`android://AbC123==@com.fortinet.forticlient/`)).toEqual({ kind: `package`, package: `com.fortinet.forticlient` });
        expect(originOfUrl(``)).toBeUndefined();
        expect(originOfUrl(`not a url`)).toBeUndefined();
    });
});

describe(`parseImport`, () => {
    it(`reads Chrome, Edge and Brave's export`, () => {
        const parsed = parseImport(
            `name,url,username,password,note\ngithub.com,https://github.com/session,radarsu,"p,ss",work\nbroken,,ann,x,\nempty,https://a.example,ann,,\n`,
        );
        expect(parsed?.format).toBe(`chrome`);
        expect(parsed?.rows).toEqual([{ origin: { kind: `site`, host: `github.com` }, title: `github.com`, username: `radarsu`, value: `p,ss`, note: `work` }]);
        expect(parsed?.skipped).toBe(2);
    });

    it(`reads Firefox's export, which has no title`, () => {
        const parsed = parseImport(
            `"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://news.ycombinator.com","pg","hunter2",,"https://news.ycombinator.com","{1}","1","2","3"\n`,
        );
        expect(parsed?.format).toBe(`firefox`);
        expect(parsed?.rows).toEqual([{ origin: { kind: `site`, host: `news.ycombinator.com` }, title: undefined, username: `pg`, value: `hunter2`, note: undefined }]);
    });

    it(`reads Safari's export`, () => {
        const parsed = parseImport(`Title,URL,Username,Password,Notes,OTPAuth\nApple ID,https://appleid.apple.com,ann@example.com,s3cret,,\n`);
        expect(parsed?.format).toBe(`safari`);
        expect(parsed?.rows[0]).toMatchObject({ title: `Apple ID`, username: `ann@example.com`, value: `s3cret` });
    });

    it(`reads 1Password's export`, () => {
        const parsed = parseImport(`Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nFigma,figma.com,ann,pw1,,false,false,design,team account\n`);
        expect(parsed?.format).toBe(`1password`);
        expect(parsed?.rows[0]).toMatchObject({ origin: { kind: `site`, host: `figma.com` }, title: `Figma`, note: `team account` });
    });

    it(`reads Bitwarden's export, leaving out what is not a login`, () => {
        const parsed = parseImport(
            `folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,GitLab,,,0,https://gitlab.com,ann,pw2,\n,,note,Wifi,the code,,0,,,,\n`,
        );
        expect(parsed?.format).toBe(`bitwarden`);
        expect(parsed?.rows.map((row) => row.title)).toEqual([`GitLab`]);
        expect(parsed?.skipped).toBe(1);
    });

    it(`reads KeePassXC's export`, () => {
        const parsed = parseImport(
            `"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n"Root/Web","Router","admin","pw3","http://192.168.1.1","","","0","2026-01-01","2025-01-01"\n"Root","No url","x","pw4","","","","0","",""\n`,
        );
        expect(parsed?.format).toBe(`keepassxc`);
        expect(parsed?.rows).toEqual([{ origin: { kind: `site`, host: `192.168.1.1` }, title: `Router`, username: `admin`, value: `pw3`, note: undefined }]);
        expect(parsed?.skipped).toBe(1);
        const named = parseImport(`"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n"Root","Bank","ann","pw5","bank.example.com","","","0","",""\n`);
        expect(named?.rows[0]).toMatchObject({ origin: { kind: `site`, host: `bank.example.com` }, title: `Bank` });
    });

    it(`keeps a password's own spaces, and answers nothing for a file it does not know`, () => {
        expect(parseImport(`name,url,username,password\nx,https://x.example,u, padded \n`)?.rows[0]?.value).toBe(` padded `);
        expect(parseImport(`a,b,c\n1,2,3\n`)).toBeUndefined();
        expect(parseImport(``)).toBeUndefined();
    });
});
