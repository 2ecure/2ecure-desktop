// 2ecure for Element Web: «Who can find you?» (docs/privacy.md).
//
// The apps ask once after signing in and keep the answer in the account data event com.2ecure.privacy
// ({"discoverable": true|false}); Synapse's twoecure_privacy module reads it when someone searches the user
// directory. Element Web has neither the question nor a setting, so this asks the same question in a dialog after
// signing in and adds the choice at the top of Settings › Security & Privacy.
//
// Everything goes through Element's module API (dialogs, account data, the profile, and React from window.React,
// which Element Web provides to modules). Only the settings section finds its place in Element's markup: if that
// markup changes, the section is simply missing. Whatever goes wrong here must never stop Element Web: every entry
// point catches its own errors.

export const EVENT_TYPE = "com.2ecure.privacy";

// The panel of the «Security & Privacy» tab (TabbedView: mx_tabpanel_<tab id>, UserTab.Security) and the list of
// sections in it (SettingsTab).
const SECURITY_TAB_PANEL = "mx_tabpanel_USER_SECURITY_TAB";
const SECTIONS_SELECTOR = ".mx_SettingsTab_sections";
const SETTINGS_SECTION_CLASS = "twoecure-privacy-settings";

// The apps' texts (TwoEcure.strings, twoecure.xml), word for word.
export const TEXTS = {
    en: {
        title: "Who can find you?",
        message: "Choose who finds you in search when they start a new chat.",
        everyone: "Everyone on 2ecure",
        everyoneDescription: "Everyone on 2ecure finds you in search and sees your name and profile picture there.",
        contacts: "Only people I chat with",
        contactsDescription:
            "You don’t appear in search. People who already share a chat with you still find you, and only they see your profile picture.",
        footer: "People who know your address can still invite you. You can change this any time in Settings.",
        continue: "Continue",
        error: "Your choice could not be saved. Please try again.",
    },
    de: {
        title: "Wer darf dich finden?",
        message: "Lege fest, wer dich in der Suche findet, wenn jemand einen neuen Chat beginnt.",
        everyone: "Alle auf 2ecure",
        everyoneDescription: "Alle auf 2ecure finden dich in der Suche und sehen dort deinen Namen und dein Profilbild.",
        contacts: "Nur Personen, mit denen ich chatte",
        contactsDescription:
            "Du erscheinst nicht in der Suche. Wer schon einen Chat mit dir teilt, findet dich weiterhin, und nur diese Personen sehen dein Profilbild.",
        footer: "Wer deine Adresse kennt, kann dich trotzdem einladen. Du kannst das jederzeit in den Einstellungen ändern.",
        continue: "Weiter",
        error: "Deine Auswahl konnte nicht gespeichert werden. Bitte versuche es noch einmal.",
    },
    fr: {
        title: "Qui peut vous trouver ?",
        message: "Choisissez qui vous trouve dans la recherche en commençant une nouvelle discussion.",
        everyone: "Tout le monde sur 2ecure",
        everyoneDescription:
            "Tout le monde sur 2ecure vous trouve dans la recherche et y voit votre nom et votre photo de profil.",
        contacts: "Seulement les personnes avec qui je discute",
        contactsDescription:
            "Vous n’apparaissez pas dans la recherche. Les personnes qui partagent déjà une discussion avec vous vous trouvent toujours, et elles seules voient votre photo de profil.",
        footer: "Les personnes qui connaissent votre adresse peuvent quand même vous inviter. Vous pouvez modifier ce choix à tout moment dans les paramètres.",
        continue: "Continuer",
        error: "Votre choix n’a pas pu être enregistré. Veuillez réessayer.",
    },
    it: {
        title: "Chi può trovarti?",
        message: "Scegli chi ti trova nella ricerca quando inizia una nuova chat.",
        everyone: "Tutti su 2ecure",
        everyoneDescription: "Tutti su 2ecure ti trovano nella ricerca e vi vedono il tuo nome e la tua immagine del profilo.",
        contacts: "Solo le persone con cui chatto",
        contactsDescription:
            "Non compari nella ricerca. Chi condivide già una chat con te ti trova comunque, e solo queste persone vedono la tua immagine del profilo.",
        footer: "Chi conosce il tuo indirizzo può comunque invitarti. Puoi cambiare questa scelta in qualsiasi momento nelle impostazioni.",
        continue: "Continua",
        error: "Non è stato possibile salvare la tua scelta. Riprova.",
    },
};

const CSS = `
.twoecure-privacy-dialog {
    max-width: 480px;
}
.twoecure-privacy-dialog p,
.twoecure-privacy-settings p {
    margin: 0 0 var(--cpd-space-4x);
    font: var(--cpd-font-body-md-regular);
    color: var(--cpd-color-text-secondary);
}
.twoecure-privacy-choices {
    display: flex;
    flex-direction: column;
    gap: var(--cpd-space-3x);
    margin-bottom: var(--cpd-space-4x);
}
.twoecure-privacy-choices > .mx_StyledRadioButton {
    padding: var(--cpd-space-3x);
}
.twoecure-privacy-choice-title {
    font: var(--cpd-font-body-md-semibold);
    color: var(--cpd-color-text-primary);
}
.twoecure-privacy-choice-description {
    font: var(--cpd-font-body-sm-regular);
    color: var(--cpd-color-text-secondary);
}
.twoecure-privacy-dialog p.twoecure-privacy-error,
.twoecure-privacy-settings p.twoecure-privacy-error {
    color: var(--cpd-color-text-critical-primary);
}
.twoecure-privacy-settings > h2 {
    margin: 0 0 var(--cpd-space-2x);
    font: var(--cpd-font-heading-sm-semibold);
    color: var(--cpd-color-text-primary);
}
`;

// true for «Everyone on 2ecure», false for «Only people I chat with», null while the account hasn't chosen.
// The same rule as the apps (PrivacyChoice): only a JSON boolean counts.
export function parseDiscoverable(content) {
    if (content === null || typeof content !== "object") return null;
    return typeof content.discoverable === "boolean" ? content.discoverable : null;
}

// Element Web's language («de», «en-GB», …); English for every language the apps don't have.
export function textsFor(language) {
    const lang = String(language || "en").slice(0, 2).toLowerCase();
    return TEXTS[lang] ?? TEXTS.en;
}

// The account data as the client has it now. Element's watchable keeps the content from when it was created and
// follows events only while watched, so every read takes a new one.
function readStored(api) {
    return parseDiscoverable(api.client.accountData.get(EVENT_TYPE).value);
}

// The choice, kept current. The effect subscribes first and only then reads the client again: a choice that synced
// between the render and the effect is not lost (Codex review REVIEW-WEB-PRIVACY.md, P1).
function useStoredChoice(api) {
    const { useState, useEffect } = window.React;
    const [stored, setStored] = useState(() => readStored(api));
    useEffect(() => {
        const watchable = api.client.accountData.get(EVENT_TYPE);
        const update = (content) => setStored(parseDiscoverable(content));
        watchable.watch(update);
        setStored(readStored(api));
        return () => watchable.unwatch(update);
    }, [api]);
    return stored;
}

// Element's own radio buttons (StyledRadioButton, outlined): the same look as its other choices.
function ChoiceRows({ t, name, selection, disabled, onSelect }) {
    const h = window.React.createElement;
    return h(
        "div",
        { className: "twoecure-privacy-choices", role: "radiogroup", "aria-label": t.title },
        [true, false].map((discoverable) => {
            const checked = selection === discoverable;
            const classes = ["mx_StyledRadioButton", "mx_StyledRadioButton_outlined"];
            classes.push(disabled ? "mx_StyledRadioButton_disabled" : "mx_StyledRadioButton_enabled");
            if (checked) classes.push("mx_StyledRadioButton_checked");
            return h(
                "label",
                { key: String(discoverable), className: classes.join(" ") },
                h("input", {
                    type: "radio",
                    name,
                    value: discoverable ? "everyone" : "contacts",
                    checked,
                    disabled,
                    onChange: () => onSelect(discoverable),
                }),
                h("div", null, h("div")),
                h(
                    "div",
                    { className: "mx_StyledRadioButton_content" },
                    h("span", { className: "twoecure-privacy-choice-title" }, discoverable ? t.everyone : t.contacts),
                    h(
                        "span",
                        { className: "twoecure-privacy-choice-description" },
                        discoverable ? t.everyoneDescription : t.contactsDescription,
                    ),
                ),
                h("div", { className: "mx_StyledRadioButton_spacer" }),
            );
        }),
    );
}

// The question after signing in. Nothing is preselected and «Continue» waits for a choice, as in the apps. Closing
// the dialog saves nothing: the account stays findable only by people it chats with, and the next start asks again.
export function PrivacyChoiceDialog({ api, t, onSubmit }) {
    const { createElement: h, useState, useEffect, useRef } = window.React;
    const stored = useStoredChoice(api);
    const [selection, setSelection] = useState(null);
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);
    // Set once the dialog has answered or was closed: a save still running then submits nothing.
    const done = useRef(false);
    useEffect(
        () => () => {
            done.current = true;
        },
        [],
    );

    const finish = (discoverable) => {
        if (done.current) return;
        done.current = true;
        onSubmit(discoverable);
    };

    // Chosen on another device or in another tab while the dialog is open: that choice stands.
    useEffect(() => {
        if (stored !== null) finish(stored);
    }, [stored]);

    const save = async () => {
        if (selection === null || saving) return;
        const current = readStored(api);
        if (current !== null) return finish(current);
        setSaving(true);
        setFailed(false);
        try {
            await api.client.accountData.set(EVENT_TYPE, { discoverable: selection });
            finish(selection);
        } catch (error) {
            console.error("2ecure: saving the privacy choice failed", error);
            setFailed(true);
            setSaving(false);
        }
    };

    return h(
        "div",
        { className: "twoecure-privacy-dialog" },
        h("p", null, t.message),
        h(ChoiceRows, {
            t,
            name: "twoecure-privacy-dialog",
            selection,
            disabled: saving,
            onSelect: (discoverable) => {
                setSelection(discoverable);
                setFailed(false);
            },
        }),
        h("p", null, t.footer),
        failed ? h("p", { className: "twoecure-privacy-error", role: "alert" }, t.error) : null,
        h(
            "div",
            { className: "mx_Dialog_buttons" },
            h(
                "span",
                { className: "mx_Dialog_buttons_row" },
                h(
                    "button",
                    {
                        type: "button",
                        className: "mx_LegacyDialogButton mx_Dialog_primary",
                        disabled: selection === null || saving,
                        onClick: save,
                    },
                    t.continue,
                ),
            ),
        ),
    );
}

// Settings › Security & Privacy: the same choice, saved as soon as it changes (as in the apps). An account that
// hasn't chosen shows «Only people I chat with», which is what the server applies to it.
export function PrivacySettingsSection({ api, t }) {
    const { createElement: h, useState, useEffect } = window.React;
    const stored = useStoredChoice(api);
    // The choice being saved, shown until the server sends the account data back.
    const [optimistic, setOptimistic] = useState(null);
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => setOptimistic(null), [stored]);

    const shown = optimistic ?? stored ?? false;

    const select = async (discoverable) => {
        if (saving || discoverable === shown) return;
        setSaving(true);
        setFailed(false);
        setOptimistic(discoverable);
        try {
            await api.client.accountData.set(EVENT_TYPE, { discoverable });
        } catch (error) {
            console.error("2ecure: saving the privacy choice failed", error);
            setOptimistic(null);
            setFailed(true);
        } finally {
            setSaving(false);
        }
    };

    return h(
        window.React.Fragment,
        null,
        h("h2", null, t.title),
        h("p", null, t.message),
        h(ChoiceRows, { t, name: "twoecure-privacy-settings", selection: shown, disabled: saving, onSelect: select }),
        failed ? h("p", { className: "twoecure-privacy-error", role: "alert" }, t.error) : null,
    );
}

// How long the question waits for the first sync before it gives up for this start.
export const FIRST_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PrivacyChoice {
    constructor(api) {
        this.api = api;
        this.askedFor = null;
        this.settings = null;
    }

    // Element Web 1.12 (module API 2.x) has everything this needs; older or different hosts get nothing.
    static isSupported(api) {
        return Boolean(
            window.React?.createElement &&
                typeof api?.openDialog === "function" &&
                typeof api?.createRoot === "function" &&
                api?.client?.accountData &&
                api?.profile?.watch,
        );
    }

    start() {
        const style = document.createElement("style");
        style.id = "twoecure-privacy";
        style.textContent = CSS;
        document.head.append(style);

        const onProfile = (profile) => {
            if (!profile?.userId || profile.isGuest) {
                this.askedFor = null;
                return;
            }
            if (this.askedFor === profile.userId) return;
            this.askedFor = profile.userId;
            this.askWhenReady(profile.userId).catch((error) => console.error("2ecure: privacy question", error));
        };
        this.api.profile.watch(onProfile);
        onProfile(this.api.profile.value);
    }

    t() {
        return textsFor(this.api.i18n?.language ?? document.documentElement.lang);
    }

    isCurrentUser(userId) {
        return this.api.profile.value?.userId === userId;
    }

    // Asks once per start, after the first sync: before it, a choice made on a phone isn't known here yet.
    async askWhenReady(userId, { pollMs = 1000, timeoutMs = FIRST_SYNC_TIMEOUT_MS } = {}) {
        await this.api.stores?.roomListStore?.waitForReady?.();
        // Synapse sends the push rules as account data in every first sync: once they are here, so is the choice.
        // Without them the choice is unknown, so this start does not ask at all (as the apps when they cannot read
        // it; Codex review REVIEW-WEB-PRIVACY.md, P1).
        for (let waited = 0; !this.hasAccountData("m.push_rules"); waited += pollMs) {
            if (waited >= timeoutMs) return;
            await delay(pollMs);
            if (!this.isCurrentUser(userId)) return;
        }
        // Not over the sign-in and «Confirm your identity» pages (AuthPage), only in the app itself.
        while (document.querySelector(".mx_AuthPage")) {
            await delay(pollMs);
            if (!this.isCurrentUser(userId)) return;
        }
        if (!this.isCurrentUser(userId)) return;
        if (readStored(this.api) !== null) return;

        const t = this.t();
        this.api.openDialog({ title: t.title }, PrivacyChoiceDialog, { api: this.api, t });
    }

    hasAccountData(eventType) {
        try {
            return this.api.client.accountData.get(eventType).value !== undefined;
        } catch {
            return false;
        }
    }

    // Called for every batch of DOM changes: puts the section into the Security & Privacy tab when it opens, and
    // unmounts it when the settings dialog closes.
    updateSettings() {
        if (this.settings && !this.settings.container.isConnected) {
            const { root } = this.settings;
            this.settings = null;
            setTimeout(() => {
                try {
                    root.unmount();
                } catch (error) {
                    console.error("2ecure: privacy settings", error);
                }
            });
        }
        if (this.settings) return;
        const sections = document.getElementById(SECURITY_TAB_PANEL)?.querySelector(SECTIONS_SELECTOR);
        if (!sections || !this.api.profile.value?.userId) return;

        const container = document.createElement("div");
        container.className = `mx_SettingsSection ${SETTINGS_SECTION_CLASS}`;
        sections.prepend(container);
        const root = this.api.createRoot(container);
        root.render(window.React.createElement(PrivacySettingsSection, { api: this.api, t: this.t() }));
        this.settings = { container, root };
    }
}
