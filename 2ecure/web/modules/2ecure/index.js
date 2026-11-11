// 2ecure for Element Web: the login page's welcome text, 2ecure's help centre behind Element's help links, and
// «Who can find you?» (privacy.js).
//
// Element Web loads this file as a runtime module. ESS mounts this directory at /modules/2ecure
// (deploy/ess/values/60-elementweb.yaml) and the image's entrypoint adds /modules/<name>/index.js to
// config.json. The texts are Element's own strings (the welcome text is «common|homeserver»), overridden per
// language in translations.json (config: custom_translations_url); this file only adds the CSS and the links.
//
// Element Web refuses to start if a module fails to load, so keep this plain, dependency-free
// JavaScript. The login text and the help links use nothing from the module API; the privacy choice uses it only
// where the host has it (PrivacyChoice.isSupported), so the module accepts every API version.

import { PrivacyChoice } from "./privacy.js";

// The languages that have a welcome text in translations.json. Every other language would show
// Element's «Homeserver» label with nothing under it, so the box is hidden there.
const LANGUAGES = ["en", "de", "fr", "it"];

// .mx_AuthBody > .mx_ServerPicker is the login page's box only: Registration nests its picker deeper.
const CSS = `
.mx_AuthBody > .mx_ServerPicker {
    display: block;
    margin-bottom: var(--cpd-space-6x);
    padding-bottom: 0;
    border-bottom: none;
}
/* The heading holds the welcome text: the greeting, a line break, then the text, with a blank line
   between paragraphs. Its other line breaks are set in translations.json too (browsers do not balance
   lines across a forced break). */
.mx_AuthBody > .mx_ServerPicker > h2 {
    margin: 0;
    white-space: pre-line;
    font: var(--cpd-font-body-md-regular);
    color: var(--cpd-color-text-secondary);
}
.mx_AuthBody > .mx_ServerPicker > h2::first-line {
    font: var(--cpd-font-body-lg-semibold);
    color: var(--cpd-color-text-primary);
}
/* The server name (and the help and Edit buttons, which disable_custom_urls already removes). */
.mx_AuthBody > .mx_ServerPicker > :not(h2) {
    display: none;
}
.mx_AuthBody > .mx_ServerPicker:not(${LANGUAGES.map((lang) => `:lang(${lang})`).join(", ")}) {
    display: none;
}
`;

// Help links that Element Web hard-codes (config.json cannot change them), and the section of 2ecure's help
// centre that answers the same question. Both help pages have the same anchors (website/README.md).
const HELP_LINKS = {
    // the «Verify this device» toast
    "https://docs.element.io/latest/element-support/device-verification/how-to-verify-devices/": "verifizierung",
    // the «Confirm your digital identity» dialog
    "https://element.io/help#encryption-device-verification": "verifizierung",
    // the warning that a contact's digital identity has changed
    "https://element.io/help#encryption18": "identitaet",
    // the sign-out dialog without key storage
    "https://element.io/en/help#encryption16": "schluesselspeicher",
    // room settings: who can read the history
    "https://element.io/en/help#e2ee-history-sharing": "verlauf",
};
const HELP_LINK_SELECTOR = Object.keys(HELP_LINKS).map((url) => `a[href="${url}"]`).join(", ");

// German at /hilfe/, every other language at /en/hilfe/. Element Web sets <html lang> to its language.
function helpUrl(anchor) {
    const path = document.documentElement.lang.startsWith("de") ? "/hilfe/" : "/en/hilfe/";
    return `https://2ecure.com${path}#${anchor}`;
}

function redirectHelpLinks(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const links = [...node.querySelectorAll(HELP_LINK_SELECTOR)];
    if (node.matches(HELP_LINK_SELECTOR)) links.push(node);
    for (const link of links) {
        link.setAttribute("href", helpUrl(HELP_LINKS[link.getAttribute("href")]));
    }
}

export default class TwoecureLogin {
    static moduleApiVersion = "*";

    constructor(api) {
        this.api = api;
    }

    async load() {
        const style = document.createElement("style");
        style.id = "twoecure-login";
        style.textContent = CSS;
        document.head.append(style);

        // The links appear whenever their toast, dialog or warning does: rewrite each one as React adds it (or
        // changes its href). React keeps the rewritten href, because it only touches attributes whose value changes.
        redirectHelpLinks(document.documentElement);

        let privacy = null;
        try {
            if (PrivacyChoice.isSupported(this.api)) {
                privacy = new PrivacyChoice(this.api);
                privacy.start();
            }
        } catch (error) {
            console.error("2ecure: privacy choice", error);
            privacy = null;
        }

        new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === "attributes") redirectHelpLinks(mutation.target);
                else mutation.addedNodes.forEach(redirectHelpLinks);
            }
            try {
                privacy?.updateSettings();
            } catch (error) {
                console.error("2ecure: privacy settings", error);
            }
        }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
    }
}
