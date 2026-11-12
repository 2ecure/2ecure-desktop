/*
Copyright 2026 2ecure

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: any[]) => any;

const { windows, sessions, revealMainWindow } = vi.hoisted(() => ({
    windows: [] as any[],
    sessions: new Map<string, any>(),
    revealMainWindow: vi.fn(),
}));

vi.mock("./window-close.js", () => ({ revealMainWindow }));

vi.mock("electron", () => {
    class FakeBrowserWindow {
        public readonly options: any;
        public readonly handlers: Record<string, Handler> = {};
        public destroyed = false;
        public readonly webContents: any;
        public loadURL = vi.fn(async () => {});
        public show = vi.fn();
        public focus = vi.fn();
        public removeMenu = vi.fn();
        public close = vi.fn(() => {
            this.destroyed = true;
            this.handlers["closed"]?.();
        });
        public constructor(options: any) {
            this.options = options;
            const contentsHandlers: Record<string, Handler> = {};
            this.webContents = {
                handlers: contentsHandlers,
                openHandler: undefined as Handler | undefined,
                on: vi.fn((name: string, cb: Handler) => {
                    contentsHandlers[name] = cb;
                }),
                setWindowOpenHandler: vi.fn(function (this: any, cb: Handler) {
                    this.openHandler = cb;
                }),
            };
            windows.push(this);
        }
        public on(name: string, cb: Handler): void {
            this.handlers[name] = cb;
        }
        public isDestroyed(): boolean {
            return this.destroyed;
        }
        public static fromWebContents(contents: unknown): FakeBrowserWindow | null {
            return windows.find((w) => w.webContents === contents) ?? null;
        }
    }
    return {
        BrowserWindow: FakeBrowserWindow,
        session: {
            fromPartition: vi.fn((partition: string) => {
                if (!sessions.has(partition)) {
                    const handlers: Record<string, Handler> = {};
                    sessions.set(partition, {
                        partition,
                        handlers,
                        setPermissionRequestHandler: vi.fn(function (this: any, cb: Handler) {
                            this.requestHandler = cb;
                        }),
                        setPermissionCheckHandler: vi.fn(function (this: any, cb: Handler) {
                            this.checkHandler = cb;
                        }),
                        on: vi.fn((name: string, cb: Handler) => {
                            handlers[name] = cb;
                        }),
                    });
                }
                return sessions.get(partition);
            }),
        },
    };
});

const AUTHORIZE = "https://account.2ecure.com/authorize?client_id=c&response_mode=fragment&state=s1";
const CALLBACK = "com.2ecure.desktop:/vector/webapp/#code=abc&state=s1";

function event(
    extra: Record<string, unknown> = {},
): { preventDefault: ReturnType<typeof vi.fn> } & Record<string, unknown> {
    return { preventDefault: vi.fn(), ...extra };
}

async function load(): Promise<typeof import("./signin-window.js")> {
    vi.resetModules();
    return import("./signin-window.js");
}

describe("2ecure sign-in window", () => {
    let mainWindow: any;
    let onCallback: ReturnType<typeof vi.fn>;
    let openExternal: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        windows.length = 0;
        sessions.clear();
        mainWindow = { name: "main" };
        global.mainWindow = mainWindow;
        revealMainWindow.mockClear();
        onCallback = vi.fn();
        openExternal = vi.fn();
    });

    afterEach(() => {
        global.mainWindow = null;
    });

    async function setUp(): Promise<typeof import("./signin-window.js")> {
        const mod = await load();
        mod.setUpSignInWindow({ scheme: "com.2ecure.desktop", onCallback, openExternal });
        return mod;
    }

    describe("isSignInUrl", () => {
        it("is the authorization endpoint of account.2ecure.com only", async () => {
            const { isSignInUrl } = await load();
            expect(isSignInUrl(AUTHORIZE)).toBe(true);
            expect(isSignInUrl("https://account.2ecure.com/authorize")).toBe(true);
            expect(isSignInUrl("https://ACCOUNT.2ecure.com:443/authorize?x=1")).toBe(true);
            for (const other of [
                "https://account.2ecure.com/account/",
                "https://account.2ecure.com/register#code=ABC",
                "https://account.2ecure.com/authorize/../account",
                "http://account.2ecure.com/authorize",
                "https://account.2ecure.com:8443/authorize",
                "https://2ecure.com/authorize",
                "https://account.2ecure.com.example.org/authorize",
                "https://account.2ecure.com@example.org/authorize",
                "vector://vector/webapp/",
                "not a url",
            ]) {
                expect(isSignInUrl(other)).toBe(false);
            }
        });
    });

    it("does nothing before it is set up, or for other addresses", async () => {
        const mod = await load();
        expect(mod.openSignInWindow(AUTHORIZE)).toBe(false);
        mod.setUpSignInWindow({ scheme: "com.2ecure.desktop", onCallback, openExternal });
        expect(mod.openSignInWindow("https://account.2ecure.com/account/")).toBe(false);
        expect(windows).toHaveLength(0);
    });

    it("opens a locked-down window of the app on the authorization URL", async () => {
        const { openSignInWindow, PARTITION } = await setUp();
        expect(openSignInWindow(AUTHORIZE)).toBe(true);
        expect(windows).toHaveLength(1);
        const win = windows[0];
        expect(win.options.parent).toBe(mainWindow);
        expect(win.options.webPreferences).toEqual(
            expect.objectContaining({
                partition: PARTITION,
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webviewTag: false,
            }),
        );
        expect(win.options.webPreferences.preload).toBeUndefined();
        expect(PARTITION).toMatch(/^persist:/);
        expect(win.removeMenu).toHaveBeenCalled();
        expect(win.loadURL).toHaveBeenCalledWith(AUTHORIZE);
        expect(openExternal).not.toHaveBeenCalled();
    });

    it("reuses the open window for a second sign-in", async () => {
        const { openSignInWindow } = await setUp();
        openSignInWindow(AUTHORIZE);
        const second = AUTHORIZE.replace("s1", "s2");
        openSignInWindow(second);
        expect(windows).toHaveLength(1);
        expect(windows[0].loadURL).toHaveBeenLastCalledWith(second);
        expect(windows[0].focus).toHaveBeenCalled();
    });

    it("refuses permissions and downloads in its own session", async () => {
        const { openSignInWindow, PARTITION } = await setUp();
        openSignInWindow(AUTHORIZE);
        const ses = sessions.get(PARTITION);
        for (const permission of ["media", "notifications", "geolocation", "clipboard-read", "openExternal"]) {
            const callback = vi.fn();
            ses.requestHandler({}, permission, callback, { externalURL: "https://example.org/" });
            expect(callback).toHaveBeenCalledWith(false);
        }
        expect(ses.checkHandler({}, "media")).toBe(false);
        const download = event();
        ses.handlers["will-download"](download, {});
        expect(download.preventDefault).toHaveBeenCalled();
        expect(onCallback).not.toHaveBeenCalled();
    });

    describe("the result of the sign-in", () => {
        it("is taken from the redirect, handed over once, and the window closes", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            const win = windows[0];
            const redirect = event({ url: CALLBACK, isMainFrame: true });
            win.webContents.handlers["will-redirect"](redirect);
            expect(redirect.preventDefault).toHaveBeenCalled();
            expect(onCallback).toHaveBeenCalledTimes(1);
            expect(onCallback).toHaveBeenCalledWith(CALLBACK);
            // The same navigation reported again (failed load, permission request): no second hand-over.
            win.webContents.handlers["did-fail-provisional-load"]({}, -3, "ERR_ABORTED", CALLBACK, true);
            sessions
                .get("persist:2ecure-account")
                .requestHandler(win.webContents, "openExternal", vi.fn(), { externalURL: CALLBACK });
            expect(onCallback).toHaveBeenCalledTimes(1);
            await new Promise((resolve) => setImmediate(resolve));
            expect(win.close).toHaveBeenCalled();
            // The app's own reveal (window-close.ts), which also un-hides the app on macOS.
            expect(revealMainWindow).toHaveBeenCalledWith(mainWindow);
            expect(openExternal).not.toHaveBeenCalled();
        });

        it("is taken from a link or form in the page (consent «Cancel»)", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            const nav = event({ url: CALLBACK.replace("code=abc", "error=access_denied"), isMainFrame: true });
            windows[0].webContents.handlers["will-frame-navigate"](nav);
            expect(nav.preventDefault).toHaveBeenCalled();
            expect(onCallback).toHaveBeenCalledWith(CALLBACK.replace("code=abc", "error=access_denied"));
        });

        it("is taken from the request to open it outside, without asking the system", async () => {
            const { openSignInWindow, PARTITION } = await setUp();
            openSignInWindow(AUTHORIZE);
            const callback = vi.fn();
            sessions
                .get(PARTITION)
                .requestHandler(windows[0].webContents, "openExternal", callback, { externalURL: CALLBACK });
            expect(onCallback).toHaveBeenCalledWith(CALLBACK);
            expect(callback).toHaveBeenCalledWith(false);
        });

        it("is dropped when it comes late from a window that is gone, and goes to the window it came from", async () => {
            const { openSignInWindow, PARTITION } = await setUp();
            openSignInWindow(AUTHORIZE);
            const first = windows[0];
            first.close(); // closed by hand; then a new «Continue»
            openSignInWindow(AUTHORIZE.replace("s1", "s2"));
            const second = windows[1];
            // The first window's external-protocol request arrives late (Electron posts it asynchronously).
            const callback = vi.fn();
            sessions
                .get(PARTITION)
                .requestHandler(first.webContents, "openExternal", callback, { externalURL: CALLBACK });
            expect(callback).toHaveBeenCalledWith(false);
            first.webContents.handlers["did-fail-provisional-load"]({}, -3, "ERR_ABORTED", CALLBACK, true);
            expect(onCallback).not.toHaveBeenCalled();
            expect(second.close).not.toHaveBeenCalled();
            // Nor from a request whose window is unknown.
            sessions.get(PARTITION).requestHandler({}, "openExternal", vi.fn(), { externalURL: CALLBACK });
            expect(onCallback).not.toHaveBeenCalled();
            // The second window's own result is taken.
            const answer = CALLBACK.replace("s1", "s2");
            second.webContents.handlers["will-redirect"](event({ url: answer, isMainFrame: true }));
            expect(onCallback).toHaveBeenCalledTimes(1);
            expect(onCallback).toHaveBeenCalledWith(answer);
        });

        it("is taken from a pop-up, which is never opened", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            expect(windows[0].webContents.openHandler({ url: CALLBACK })).toEqual({ action: "deny" });
            expect(onCallback).toHaveBeenCalledWith(CALLBACK);
            expect(openExternal).not.toHaveBeenCalled();
        });

        it("is not taken for another scheme", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            const nav = event({ url: "io.element.desktop:/vector/webapp/#code=abc&state=s1", isMainFrame: true });
            windows[0].webContents.handlers["will-frame-navigate"](nav);
            expect(nav.preventDefault).toHaveBeenCalled();
            expect(onCallback).not.toHaveBeenCalled();
        });
    });

    describe("where the window may go", () => {
        it("stays on account.2ecure.com", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            const handlers = windows[0].webContents.handlers;
            for (const url of [
                "https://account.2ecure.com/login?next=x",
                "https://account.2ecure.com/register#code=ABC",
                "https://account.2ecure.com/consent/123",
            ]) {
                const frame = event({ url, isMainFrame: true });
                handlers["will-frame-navigate"](frame);
                handlers["will-navigate"](frame);
                handlers["will-redirect"](event({ url, isMainFrame: true }));
                expect(frame.preventDefault).not.toHaveBeenCalled();
            }
            expect(openExternal).not.toHaveBeenCalled();
        });

        it("sends links elsewhere to the system browser", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            const nav = event({ url: "https://2ecure.com/datenschutz", isMainFrame: true });
            windows[0].webContents.handlers["will-frame-navigate"](nav);
            expect(nav.preventDefault).toHaveBeenCalled();
            expect(openExternal).toHaveBeenCalledWith("https://2ecure.com/datenschutz");
            // window.open goes the same way, and never opens a window of the app.
            expect(windows[0].webContents.openHandler({ url: "https://2ecure.com/agb" })).toEqual({ action: "deny" });
            expect(openExternal).toHaveBeenLastCalledWith("https://2ecure.com/agb");
        });

        it("keeps pop-ups to the account service in the same window", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            const register = "https://account.2ecure.com/register#code=INVITE";
            expect(windows[0].webContents.openHandler({ url: register })).toEqual({ action: "deny" });
            expect(windows[0].loadURL).toHaveBeenLastCalledWith(register);
            expect(windows).toHaveLength(1);
            expect(openExternal).not.toHaveBeenCalled();
        });

        it("sends a form posted to a new window as the same POST in this window", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            const url = "https://account.2ecure.com/register/password";
            const data = [{ type: "rawData", bytes: Buffer.from("------X\r\n...") }];
            const referrer = { url: "https://account.2ecure.com/register", policy: "strict-origin-when-cross-origin" };
            const postBody = { contentType: "multipart/form-data", boundary: "----X", data };
            expect(windows[0].webContents.openHandler({ url, postBody, referrer })).toEqual({ action: "deny" });
            expect(windows[0].loadURL).toHaveBeenLastCalledWith(url, {
                postData: data,
                extraHeaders: "content-type: multipart/form-data; boundary=----X",
                httpReferrer: referrer,
            });
            const form = { contentType: "application/x-www-form-urlencoded", data };
            windows[0].webContents.openHandler({ url, postBody: form, referrer });
            expect(windows[0].loadURL).toHaveBeenLastCalledWith(url, {
                postData: data,
                extraHeaders: "content-type: application/x-www-form-urlencoded",
                httpReferrer: referrer,
            });
            expect(windows).toHaveLength(1);
            expect(openExternal).not.toHaveBeenCalled();
        });

        it("does not show documents made from the account service's origin (blob:, data:, about:)", async () => {
            const { openSignInWindow, isSignInUrl } = await setUp();
            openSignInWindow(AUTHORIZE);
            const handlers = windows[0].webContents.handlers;
            for (const url of [
                "blob:https://account.2ecure.com/0b3c1f6e-1d2a-4c8e-9f00-1234567890ab",
                "data:text/html,<p>x</p>",
                "about:blank",
                "javascript:alert(1)",
            ]) {
                for (const isMainFrame of [true, false]) {
                    const frame = event({ url, isMainFrame });
                    handlers["will-frame-navigate"](frame);
                    expect(frame.preventDefault).toHaveBeenCalled();
                }
                expect(windows[0].webContents.openHandler({ url })).toEqual({ action: "deny" });
            }
            expect(windows[0].loadURL).toHaveBeenCalledTimes(1);
            expect(isSignInUrl("blob:https://account.2ecure.com/authorize")).toBe(false);
            expect(onCallback).not.toHaveBeenCalled();
        });

        it("only stops redirects and frames that lead elsewhere", async () => {
            const { openSignInWindow } = await setUp();
            openSignInWindow(AUTHORIZE);
            const handlers = windows[0].webContents.handlers;
            const redirect = event({ url: "https://example.org/", isMainFrame: true });
            handlers["will-redirect"](redirect);
            const frame = event({ url: "https://example.org/frame", isMainFrame: false });
            handlers["will-frame-navigate"](frame);
            const http = event({ url: "http://account.2ecure.com/login", isMainFrame: false });
            handlers["will-frame-navigate"](http);
            expect(redirect.preventDefault).toHaveBeenCalled();
            expect(frame.preventDefault).toHaveBeenCalled();
            expect(http.preventDefault).toHaveBeenCalled();
            expect(openExternal).not.toHaveBeenCalled();
        });
    });

    it("leaves the app as it was when the window is closed by hand", async () => {
        const { openSignInWindow } = await setUp();
        openSignInWindow(AUTHORIZE);
        windows[0].close();
        expect(onCallback).not.toHaveBeenCalled();
        // The next «Continue» gets a new window.
        openSignInWindow(AUTHORIZE);
        expect(windows).toHaveLength(2);
        expect(windows[1].loadURL).toHaveBeenCalledWith(AUTHORIZE);
    });
});
