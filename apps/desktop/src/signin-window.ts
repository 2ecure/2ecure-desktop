/*
Copyright 2026 2ecure

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

/*
 * 2ecure: sign-in inside the app instead of the system browser.
 *
 * Element starts its OAuth 2.0 sign-in (and «Create account») by pointing the main window at the account service's
 * authorization endpoint; Element Desktop hands that to the system browser, and the result comes back through the
 * app's link scheme. Here the authorization endpoint of 2ecure's own account service opens in a window of the app
 * instead, and the result (`com.2ecure.desktop:/vector/webapp/?no_universal_links=true#code=…&state=…`) is taken
 * from that window and given to the same handler as a link from the system (ProtocolHandler.handleDeeplink). The
 * system's link scheme stays registered as the fallback.
 *
 * RFC 8252 advises against such embedded windows because the app could read what is typed into them. Here app and
 * account service are the same party (2ecure), so that concern does not apply. The cost: browser password managers do
 * not fill this window, and a sign-in already made in the browser is not reused.
 *
 * The window: no preload, no Node.js, context isolation and sandbox on, its own persistent partition (the app's
 * vector:// pages and their IPC bridge share nothing with it), the main window as its parent. It shows only
 * https://account.2ecure.com: links elsewhere go to the system browser (safeOpenURL), everything else is refused, and
 * so are pop-ups, permission requests and downloads. Certificate errors are never overridden (Electron refuses them by
 * default and nothing here changes that).
 */

import { BrowserWindow, session, type Session } from "electron";

import { revealMainWindow } from "./window-close.js";

/** 2ecure's account service (MAS): its authorization endpoint opens in the sign-in window, which shows only this origin. */
const ACCOUNT_ORIGIN = "https://account.2ecure.com";
const AUTHORIZATION_PATH = "/authorize";
/** Kept on disk like a browser profile: the account service's own sign-in (its session cookie) survives a restart. */
export const PARTITION = "persist:2ecure-account";

export interface SignInWindowOptions {
    /** The app's link scheme, e.g. `com.2ecure.desktop` (the OAuth redirect URI's scheme). */
    scheme: string;
    /** Takes the result of the sign-in, as a link from the system would be taken. */
    onCallback: (url: string) => void;
    /** Opens a link in the system browser (it checks the scheme itself). */
    openExternal: (url: string) => void;
}

let options: SignInWindowOptions | undefined;
let signInWindow: BrowserWindow | null = null;
let preparedSession: Session | undefined;
// Several events can report the same navigation (will-redirect, will-frame-navigate, the permission request, the
// failed load): each window hands over at most one result.
const finished = new WeakSet<BrowserWindow>();

export function setUpSignInWindow(opts: SignInWindowOptions): void {
    options = opts;
}

function parse(target: string): URL | undefined {
    try {
        return new URL(target);
    } catch {
        return undefined;
    }
}

/** A page of the account service itself: https only (a blob: or similar URL made there has the same origin). */
function isAccountPage(url: URL | undefined): url is URL {
    return url?.protocol === "https:" && url.origin === ACCOUNT_ORIGIN;
}

/** Whether a navigation of the main window starts a sign-in or registration at 2ecure's account service. */
export function isSignInUrl(target: string): boolean {
    const url = parse(target);
    return isAccountPage(url) && url.pathname === AUTHORIZATION_PATH;
}

function isCallback(url: URL): boolean {
    return !!options && url.protocol === `${options.scheme}:`;
}

/**
 * If `target` is an address of the app's link scheme, reported by the sign-in window `owner`: hand it to the app
 * once and close `owner`. A late report of a window that is closed or already done is dropped (Electron posts the
 * external-protocol request asynchronously, so it can arrive after its window is gone or a new one is open); a link
 * from the system still takes the OS route (ProtocolHandler).
 * @returns whether `target` was such an address (the caller then stops the navigation).
 */
function takeCallback(target: string, owner: BrowserWindow | null): boolean {
    const url = parse(target);
    if (!url || !isCallback(url)) return false;
    if (!owner || owner.isDestroyed() || finished.has(owner)) return true;
    finished.add(owner);
    options!.onCallback(url.href);
    // Not inside Electron's navigation callback that reported the address: one tick later.
    setImmediate(() => owner.isDestroyed() || owner.close());
    // As the app does for a second start (also un-hides the app on macOS, where closing the main window hides it).
    if (global.mainWindow) revealMainWindow(global.mainWindow);
    return true;
}

/**
 * Where the sign-in window may go. Called for every navigation it reports; the first answer that stops a navigation
 * is final (Electron reports will-frame-navigate before will-navigate and skips the latter once stopped).
 */
function guard(
    owner: BrowserWindow,
    event: { preventDefault(): void },
    target: string,
    isMainFrame: boolean,
    isRedirect: boolean,
): void {
    if (takeCallback(target, owner)) {
        event.preventDefault();
        return;
    }
    if (isAccountPage(parse(target))) return;
    event.preventDefault();
    // A link the user follows (terms, privacy policy on 2ecure.com, …) opens in the system browser; redirects and
    // frames that lead elsewhere are only stopped.
    if (isMainFrame && !isRedirect) options!.openExternal(target);
}

/**
 * A form sent to a new window (method=post target=_blank) is sent again in this window as the same POST, with the
 * body and encoding Electron hands to the window-open handler (postBody, lib/browser/web-contents.ts).
 */
function postOptions(postBody: Electron.PostBody, referrer: Electron.Referrer): Electron.LoadURLOptions {
    const contentType = postBody.boundary
        ? `${postBody.contentType}; boundary=${postBody.boundary}`
        : postBody.contentType;
    return { postData: postBody.data, extraHeaders: `content-type: ${contentType}`, httpReferrer: referrer };
}

function prepareSession(): Session {
    const ses = session.fromPartition(PARTITION);
    if (preparedSession === ses) return ses;
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
        // An address of the app's link scheme that got past the navigation events ends up here, as a request to
        // open it outside: it is taken in the app instead, and the system is never asked.
        if (permission === "openExternal") {
            const externalURL = (details as Electron.OpenExternalPermissionRequest).externalURL;
            if (externalURL) takeCallback(externalURL, BrowserWindow.fromWebContents(webContents));
        }
        callback(false);
    });
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (event) => event.preventDefault());
    preparedSession = ses;
    return ses;
}

/**
 * Opens (or reuses) the sign-in window on `target`, an authorization URL of 2ecure's account service.
 * @returns false if the window is not set up or `target` is not such a URL; the caller then uses the system browser.
 */
export function openSignInWindow(target: string): boolean {
    if (!options || !isSignInUrl(target)) return false;

    if (signInWindow && !signInWindow.isDestroyed() && !finished.has(signInWindow)) {
        // A second «Continue»: Element made a new request (new state), so the window follows it.
        void signInWindow.loadURL(target);
        signInWindow.show();
        signInWindow.focus();
        return true;
    }

    prepareSession();
    const win = new BrowserWindow({
        parent: global.mainWindow ?? undefined,
        width: 480,
        height: 720,
        minWidth: 360,
        minHeight: 480,
        title: "2ecure",
        backgroundColor: "#ffffff",
        autoHideMenuBar: true,
        webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
            navigateOnDragDrop: false,
            safeDialogs: true,
            // Electron fetches spell-checking dictionaries from Google on Linux; nothing here needs them.
            spellcheck: false,
        },
    });
    // No application menu in this window (Windows, Linux): its reload and developer tools act on the main window.
    win.removeMenu();
    signInWindow = win;

    const contents = win.webContents;
    contents.setWindowOpenHandler(({ url, postBody, referrer }) => {
        if (takeCallback(url, win)) return { action: "deny" };
        // A page of the account service (e.g. a registration link with target=_blank) stays in this window, with
        // its sessionStorage (the invitation code); anything else goes to the system browser. Never a new window.
        if (!isAccountPage(parse(url))) options!.openExternal(url);
        else if (postBody) void win.loadURL(url, postOptions(postBody, referrer));
        else void win.loadURL(url);
        return { action: "deny" };
    });
    contents.on("will-frame-navigate", (event) => guard(win, event, event.url, event.isMainFrame, false));
    contents.on("will-navigate", (event) => guard(win, event, event.url, true, false));
    contents.on("will-redirect", (event) => guard(win, event, event.url, event.isMainFrame, true));
    // Once stopped (or handed to the system), a navigation to the link scheme ends as a failed load; take it from there
    // too, in case it came by a route none of the above reports.
    contents.on("did-fail-provisional-load", (_event, _code, _description, validatedURL, isMainFrame) => {
        if (isMainFrame) takeCallback(validatedURL, win);
    });
    win.on("closed", () => {
        if (signInWindow === win) signInWindow = null;
    });

    void win.loadURL(target);
    return true;
}
