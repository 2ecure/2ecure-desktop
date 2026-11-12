/*
Copyright 2026 2ecure

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

// 2ecure: the main window hands the sign-in at account.2ecure.com to the sign-in window (signin-window.ts) and
// everything else to the system browser, as before.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { shell } from "electron";

const { openSignInWindow } = vi.hoisted(() => ({ openSignInWindow: vi.fn((_url: string) => true) }));

vi.mock("electron", () => ({
    clipboard: { writeText: vi.fn() },
    Menu: class {},
    MenuItem: class {},
    shell: { openExternal: vi.fn(), openPath: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() },
    ipcMain: { on: vi.fn() },
}));
vi.mock("./language-helper.js", () => ({ _t: (key: string): string => key }));
vi.mock("./config.js", () => ({ getConfig: (): Record<string, never> => ({}) }));
vi.mock("./save-image.js", () => ({ saveImageToFile: vi.fn() }));
vi.mock("./signin-window.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./signin-window.js")>()),
    openSignInWindow,
}));

const registerWebContentsHandlers = (await import("./webcontents-handler.js")).default;

const AUTHORIZE = "https://account.2ecure.com/authorize?client_id=c&prompt=create&state=s1";

function setUp(): {
    handlers: Record<string, (...args: any[]) => any>;
    openHandler: (details: { url: string }) => unknown;
} {
    const handlers: Record<string, (...args: any[]) => any> = {};
    let openHandler: any;
    registerWebContentsHandlers({
        setWindowOpenHandler: (cb: any) => {
            openHandler = cb;
        },
        on: (name: string, cb: any) => {
            handlers[name] = cb;
        },
        session: { on: vi.fn() },
    } as any);
    return { handlers, openHandler };
}

describe("main window: sign-in at account.2ecure.com", () => {
    beforeEach(() => {
        vi.mocked(shell.openExternal).mockClear();
        openSignInWindow.mockClear();
        openSignInWindow.mockReturnValue(true);
    });

    it("opens the authorization URL in the sign-in window, not the system browser", () => {
        const { handlers } = setUp();
        const ev = { preventDefault: vi.fn() };
        handlers["will-navigate"](ev, AUTHORIZE);
        expect(ev.preventDefault).toHaveBeenCalled();
        expect(openSignInWindow).toHaveBeenCalledWith(AUTHORIZE);
        expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it("does the same for window.open", () => {
        const { openHandler } = setUp();
        expect(openHandler({ url: AUTHORIZE })).toEqual({ action: "deny" });
        expect(openSignInWindow).toHaveBeenCalledWith(AUTHORIZE);
        expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it("falls back to the system browser when the window cannot open", () => {
        openSignInWindow.mockReturnValue(false);
        const { handlers } = setUp();
        handlers["will-navigate"]({ preventDefault: vi.fn() }, AUTHORIZE);
        expect(shell.openExternal).toHaveBeenCalledWith(AUTHORIZE);
    });

    it("keeps account pages and other links in the system browser", () => {
        const { handlers, openHandler } = setUp();
        handlers["will-navigate"](
            { preventDefault: vi.fn() },
            "https://account.2ecure.com/account/?action=sessions_list",
        );
        openHandler({ url: "https://2ecure.com/hilfe" });
        expect(openSignInWindow).not.toHaveBeenCalled();
        expect(shell.openExternal).toHaveBeenCalledWith("https://account.2ecure.com/account/?action=sessions_list");
        expect(shell.openExternal).toHaveBeenCalledWith("https://2ecure.com/hilfe");
    });

    it("leaves the app's own pages alone", () => {
        const { handlers } = setUp();
        const ev = { preventDefault: vi.fn() };
        handlers["will-navigate"](ev, "vector://vector/webapp/#/login");
        expect(ev.preventDefault).not.toHaveBeenCalled();
        expect(openSignInWindow).not.toHaveBeenCalled();
    });
});
