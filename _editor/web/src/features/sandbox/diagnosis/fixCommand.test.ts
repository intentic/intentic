import { installScriptUrl } from "@intentic/constants";
import { scriptSource } from "../../../app/environments/scriptCommand";
import { fixCommand } from "./fixCommand";

// The one command, pinned in its published spelling, since that is what a reader on another machine pastes.

beforeEach(() => {
    scriptSource.value = `published`;
});

it(`carries the fix code in each shell's own spelling`, () => {
    expect(fixCommand(`Q7XK2M9PLT4`, `unix`)).toBe(`curl -fsSL ${installScriptUrl(`fix`)} | sh -s -- Q7XK2M9PLT4`);
    expect(fixCommand(`Q7XK2M9PLT4`, `windows`)).toBe(`$env:FIX_CODE='Q7XK2M9PLT4'; irm ${installScriptUrl(`fixPs1`)} | iex`);
});

it(`still works with no code, only unobserved`, () => {
    expect(fixCommand(undefined, `unix`)).toBe(`curl -fsSL ${installScriptUrl(`fix`)} | sh`);
    expect(fixCommand(undefined, `windows`)).toBe(`irm ${installScriptUrl(`fixPs1`)} | iex`);
});

it(`never lets anything but a minted code into a shell`, () => {
    expect(fixCommand(`x'; rm -rf ~; '`, `windows`)).toBe(`irm ${installScriptUrl(`fixPs1`)} | iex`);
    expect(fixCommand(`$(reboot)`, `unix`)).toBe(`curl -fsSL ${installScriptUrl(`fix`)} | sh`);
});

it(`is served from the /fix scripts`, () => {
    expect(installScriptUrl(`fix`)).toBe(`https://intentic.dev/fix`);
    expect(installScriptUrl(`fixPs1`)).toBe(`https://intentic.dev/fix.ps1`);
});
