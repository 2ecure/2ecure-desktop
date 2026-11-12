/*
Copyright 2026 2ecure

2ecure: checks of the packaged 2ecure desktop app (Element's own launch tests expect Element's welcome page and
its io.element.desktop scheme). Run against a built app:

    ELEMENT_DESKTOP_EXECUTABLE=<path of 2ecure.exe or 2ecure.app/Contents/MacOS/2ecure> pnpm playwright test 2ecure

The EnableNodeCliInspectArguments fuse must be on for Playwright (electron-fuses write …), as in Element's CI.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
*/

import { test, expect } from "../element-desktop-test.js";

// Merges with the declarations of Element's own launch tests (launch.spec.ts, oidc.spec.ts).
declare global {
    interface ElectronPlatform {
        getEventIndexingManager():
            | {
                  supportsEventIndexing(): Promise<boolean>;
              }
            | undefined;
        createPickleKey(userId: string, deviceId: string): Promise<string | null>;
        getOAuthCallbackUrl(): URL;
    }

    interface Window {
        mxPlatformPeg: {
            get(): ElectronPlatform;
        };
    }
}

// Hosts the app may contact: 2ecure's own (the server, the account service, the website for help and updates).
const ALLOWED = /^(?:[a-z0-9-]+\.)*2ecure\.com$/;

test.describe("2ecure desktop", () => {
    test.slow();

    test("starts at the 2ecure sign-in and contacts only 2ecure", async ({ app, page }) => {
        const hosts = new Set<string>();
        app.context().on("request", (request) => {
            const url = new URL(request.url());
            if (url.protocol === "http:" || url.protocol === "https:") hosts.add(url.hostname);
        });
        await page.locator("#matrixchat").waitFor();
        await page.locator(".mx_AuthPage").waitFor({ timeout: 60_000 });
        await expect(page).toHaveTitle(/2ecure/);
        expect(page.url()).toMatch(/^vector:\/\/vector\/webapp\//);
        // The 2ecure module (modules/2ecure/index.js) is loaded: it adds its style element.
        await expect(page.locator("style#twoecure-login")).toHaveCount(1);
        // Let the start-up requests finish (server discovery, sign-in metadata).
        await page.waitForTimeout(15_000);
        expect(hosts.size).toBeGreaterThan(0);
        expect([...hosts].filter((h) => !ALLOWED.test(h))).toEqual([]);
    });

    test("supports search in encrypted rooms (seshat)", async ({ page }) => {
        await page.locator("#matrixchat").waitFor();
        await expect(
            page.evaluate(async () => window.mxPlatformPeg.get().getEventIndexingManager()?.supportsEventIndexing()),
        ).resolves.toBeTruthy();
    });

    test("keeps keys in the system's secure storage", async ({ page }) => {
        await page.locator("#matrixchat").waitFor();
        await expect(
            page.evaluate(() => window.mxPlatformPeg.get().createPickleKey("@test:2ecure.com", "ABCDEF")),
        ).resolves.not.toBeNull();
    });

    test("signs in with the com.2ecure.desktop callback", async ({ page }) => {
        await page.locator("#matrixchat").waitFor();
        await expect(page.evaluate(() => window.mxPlatformPeg.get().getOAuthCallbackUrl().toString())).resolves.toMatch(
            /^com\.2ecure\.desktop:\/vector\/webapp\//,
        );
    });

    // Sign-in in a window of the app (patch «sign-in inside the app», src/signin-window.ts), not the system browser.
    test("signs in inside the app, not in the system browser", async ({ app, page }) => {
        // What the app hands to the system browser is recorded instead of opened.
        await app.evaluate(({ shell }) => {
            const opened: string[] = [];
            (globalThis as { twoecureOpened?: string[] }).twoecureOpened = opened;
            shell.openExternal = async (url: string): Promise<void> => {
                opened.push(url);
            };
        });
        const opened = (): Promise<string[]> =>
            app.evaluate(() => (globalThis as { twoecureOpened?: string[] }).twoecureOpened ?? []);

        await page.locator(".mx_AuthPage").waitFor({ timeout: 60_000 });
        const signInWindow = app.waitForEvent("window");
        // Element's «Continue» (Login.tsx, OAuth). Not waiting after the click: the main window's navigation to the
        // account service is stopped by the app before it sends a request, and Playwright's wait for navigations a
        // click starts (in Chromium) ends only at a commit or a failed request.
        await page.locator(".mx_Login_fullWidthButton").click({ noWaitAfter: true });
        const signIn = await signInWindow;
        // The account service's sign-in form, in the app.
        await signIn.waitForURL(/^https:\/\/account\.2ecure\.com\//, { timeout: 60_000 });
        await expect(signIn.locator('input[name="username"]')).toBeVisible({ timeout: 60_000 });
        expect(page.url()).toMatch(/^vector:\/\/vector\/webapp\//);
        expect(await opened()).toEqual([]);

        // The window: a child of the main window with its own persistent session, without Node.js and without the
        // app's preload bridge (window.electron); the exact settings are in signin-window.test.ts.
        const settings = await app.evaluate(({ BrowserWindow, session }) => {
            const all = BrowserWindow.getAllWindows();
            const win = all.find((w) => w.webContents.getURL().startsWith("https://account.2ecure.com/"));
            const main = all.find((w) => w.webContents.getURL().startsWith("vector://"));
            return {
                parentIsMain: !!win && win.getParentWindow() === main,
                ownSession: !!win && win.webContents.session !== session.defaultSession,
                persistent: !!win && win.webContents.session.isPersistent(),
            };
        });
        expect(settings).toEqual({ parentIsMain: true, ownSession: true, persistent: true });
        await expect(
            // oxlint-disable-next-line unicorn/prefer-module -- the point: the page has no CommonJS require (no Node.js)
            signIn.evaluate(() => [typeof (window as { electron?: unknown }).electron, typeof require, typeof process]),
        ).resolves.toEqual(["undefined", "undefined", "undefined"]);

        // A link elsewhere (the privacy policy on 2ecure.com) goes to the system browser; the window stays.
        await signIn.evaluate(() => {
            window.location.href = "https://2ecure.com/datenschutz";
        });
        await expect.poll(opened).toEqual(["https://2ecure.com/datenschutz"]);
        expect(signIn.url()).toMatch(/^https:\/\/account\.2ecure\.com\//);

        // The answer comes back to the app the way a link from the system would: with prompt=none the account
        // service answers at once, a redirect to com.2ecure.desktop:/vector/webapp/#error=login_required&state=…
        // (MAS, authorization/mod.rs). The window catches it, closes, and the main window gets Element's state back.
        const { clientId, state, redirectUri } = await page.evaluate(() => {
            const context = JSON.parse(sessionStorage.getItem("mx_oauth_state")!);
            return {
                clientId: context.authContext.clientId as string,
                state: context.state as string,
                redirectUri: window.mxPlatformPeg.get().getOAuthCallbackUrl().toString(),
            };
        });
        const authorize = new URL("https://account.2ecure.com/authorize");
        for (const [key, value] of Object.entries({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            response_mode: "fragment",
            scope: "openid",
            state,
            prompt: "none",
        })) {
            authorize.searchParams.set(key, value);
        }
        // What happens to the main window, recorded in order in the main process: Element reads the answer and then
        // removes it from the address (vector/app.tsx, history.replaceState), so the address is no reliable witness.
        type MainEvent = { kind: "load" | "commit" | "in-page"; url: string };
        await app.evaluate(({ BrowserWindow }) => {
            const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("vector://"))!;
            const events: { kind: string; url: string }[] = [];
            (globalThis as { twoecureMain?: typeof events }).twoecureMain = events;
            const loadURL = main.loadURL.bind(main);
            main.loadURL = (url, options) => {
                events.push({ kind: "load", url });
                return loadURL(url, options);
            };
            main.webContents.on("did-navigate", (_event, url) => events.push({ kind: "commit", url }));
            main.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
                if (isMainFrame) events.push({ kind: "in-page", url });
            });
        });
        const mainEvents = (): Promise<MainEvent[]> =>
            app.evaluate(() => (globalThis as { twoecureMain?: MainEvent[] }).twoecureMain ?? []);
        const fragment = (url: string): URLSearchParams => new URLSearchParams(new URL(url).hash.slice(1));

        const closed = signIn.waitForEvent("close");
        await signIn.goto(authorize.href).catch((error: Error) => {
            // The app stops this navigation and closes the window: expected. Anything else is a failure.
            if (!/ERR_ABORTED|Target page, context or browser has been closed|page was closed/i.test(error.message)) {
                throw error;
            }
        });
        await closed;

        // Handed over once, the way a link from the system is: vector://vector/webapp/ with Element's redirect query
        // (?no_universal_links=true) and the account service's answer in the fragment.
        const loads = (await mainEvents()).filter((e) => e.kind === "load");
        expect(loads).toHaveLength(1);
        const target = new URL(loads[0].url);
        expect([target.protocol, target.host, target.pathname]).toEqual(["vector:", "vector", "/webapp/"]);
        expect(target.searchParams.get("no_universal_links")).toBe("true");
        const answer = fragment(loads[0].url);
        expect({ error: answer.get("error"), state: answer.get("state") }).toEqual({ error: "login_required", state });

        // The new page with the answer was loaded, and Element in that page read the answer and removed it.
        await expect
            .poll(
                async () => {
                    const events = await mainEvents();
                    const commit = events.findIndex(
                        (e) => e.kind === "commit" && fragment(e.url).get("state") === state,
                    );
                    if (commit < 0) return "answer page not loaded";
                    const cleaned = events
                        .slice(commit + 1)
                        .some((e) => e.kind === "in-page" && !fragment(e.url).has("state"));
                    return cleaned ? "consumed" : "answer not consumed";
                },
                { timeout: 30_000 },
            )
            .toBe("consumed");
        await expect(page.locator("#matrixchat")).toBeVisible();
        expect(await opened()).toEqual(["https://2ecure.com/datenschutz"]);
    });
});
