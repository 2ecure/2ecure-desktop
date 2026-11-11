/*
2ecure: checks of the packaged 2ecure desktop app (Element's own launch tests expect Element's welcome page and
its io.element.desktop scheme). Run against a built app:

    ELEMENT_DESKTOP_EXECUTABLE=<path of 2ecure.exe or 2ecure.app/Contents/MacOS/2ecure> pnpm playwright test 2ecure

The EnableNodeCliInspectArguments fuse must be on for Playwright (electron-fuses write …), as in Element's CI.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
*/

import { test, expect } from "../element-desktop-test.js";

declare global {
    interface Window {
        mxPlatformPeg: {
            get(): {
                getEventIndexingManager(): { supportsEventIndexing(): Promise<boolean> } | undefined;
                createPickleKey(userId: string, deviceId: string): Promise<string | null>;
                getOAuthCallbackUrl(): URL;
            };
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
        await expect(
            page.evaluate(() => window.mxPlatformPeg.get().getOAuthCallbackUrl().toString()),
        ).resolves.toMatch(/^com\.2ecure\.desktop:\/vector\/webapp\//);
    });
});
