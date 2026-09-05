import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import Backend from 'i18next-http-backend';

interface LocalizeOptions {
    ellipsis?: boolean;
    // any other values are forwarded to i18next as {{placeholder}} interpolation data
    [key: string]: unknown;
}

// minimal shapes the binders operate on (pcui elements emit a 'destroy' event)
type Destroyable = { once?: (event: string, fn: () => void) => void };
type TextElement = { text: string } & Destroyable;
type Option = { v: any, t: string };
type SelectElement = { value: any, options: Option[] } & Destroyable;

/**
 * Wraps i18next and adds reactive localization: UI strings bound through the
 * helpers below re-translate live when the language changes, with no page
 * reload. A single shared instance is exported as {@link i18n}.
 *
 * IMPORTANT: any persistent UI string must be registered via bindText /
 * bindOptions / onChange, or it will NOT update when the user switches language.
 * Plain {@link Localization.t} is only correct for strings re-evaluated at call
 * time (e.g. popup messages built when shown).
 */
class Localization {
    /**
     * Supported languages. `name` is the NATIVE name so a user who can't read
     * the current UI language can still recognise their own. Single source of
     * truth for both i18next init and the language selector.
     */
    readonly languages = [
        { code: 'en', name: 'English' },
        { code: 'de', name: 'Deutsch' },
        { code: 'es', name: 'Español' },
        { code: 'fr', name: 'Français' },
        { code: 'ja', name: '日本語' },
        { code: 'ko', name: '한국어' },
        { code: 'pt-BR', name: 'Português (Brasil)' },
        { code: 'ru', name: 'Русский' },
        { code: 'zh-CN', name: '中文 (简体)' }
    ];

    private updaters = new Set<() => void>();

    // Existing ReSplat UI still calls localize() while newer controls use the
    // reactive binders. Keep enough metadata to update those legacy DOM nodes
    // live as well, so switching language never requires a reload.
    private legacyRecords = new Map<string, { key: string, options?: LocalizeOptions, text: string }>();

    // localStorage key i18next's detector reads. We write it ONLY on an explicit
    // user choice (see setLanguage), never auto-cached, so its presence reliably
    // means "the user pinned a language" rather than "detected this time".
    private readonly storageKey = 'i18nextLng';

    /** Initialise i18next. Call once at startup, before building the UI. */
    init() {
        i18next.on('languageChanged', () => {
            this.updateLegacyDom();
            this.updaters.forEach(fn => fn());
        });

        return i18next
        .use(Backend)
        .use(LanguageDetector)
        .init({
            detection: {
                // `querystring` (?lng=) wins so shareable links keep working.
                // `localStorage` holds an EXPLICIT user choice and takes
                // precedence over the browser locale. `navigator` is the default
                // when nothing is stored. caches:[] disables i18next's automatic
                // write-back so a stored value only ever means an explicit pick
                // (setLanguage manages the key itself).
                order: ['querystring', 'localStorage', 'navigator', 'htmlTag'],
                caches: []
            },
            backend: {
                loadPath: './static/locales/{{lng}}.json'
            },
            supportedLngs: this.languages.map(l => l.code),
            fallbackLng: 'en',
            interpolation: {
                escapeValue: false
            }
        });
    }

    /** Translate a key. Extra option values interpolate into {{placeholders}}. */
    t(key: string, options?: LocalizeOptions): string {
        let text = i18next.t(key, options);

        if (options?.ellipsis) text += '...';

        return text;
    }

    /** The active language code (e.g. 'en', 'pt-BR'). */
    get locale(): string {
        return i18next.language || 'en';
    }

    /**
     * The explicitly chosen language code, or null when on "Automatic"
     * (detection-driven). Use this for the selector's default so an untouched
     * setting reads "Automatic" rather than the detected language.
     */
    get storedLanguage(): string | null {
        return localStorage.getItem(this.storageKey);
    }

    /**
     * Switch language live (no reload). Pass a language code to pin it
     * explicitly (persisted to localStorage), or null for "Automatic" — forgets
     * the stored choice and reverts to the browser-detected language.
     */
    setLanguage(code: string | null): Promise<unknown> {
        if (code === null) {
            localStorage.removeItem(this.storageKey);
            const detected = i18next.services.languageDetector?.detect();
            const detectedLng = Array.isArray(detected) ? detected[0] : detected;
            return i18next.changeLanguage(detectedLng || 'en');
        }
        localStorage.setItem(this.storageKey, code);
        return i18next.changeLanguage(code);
    }

    /**
     * Run `update` now and on every subsequent language change. Auto-removed
     * when the owning element is destroyed (any pcui Element, which emits
     * 'destroy'). Returns an unbind function for manual removal.
     */
    onChange(update: () => void, owner?: Destroyable): () => void {
        update();
        this.updaters.add(update);
        const unbind = () => this.updaters.delete(update);
        owner?.once?.('destroy', unbind);
        return unbind;
    }

    /**
     * Bind an element's `.text` to a localization key OR a builder function.
     * Works for both Label and Button (Button shares the `.text` setter) and any
     * element exposing `.text`. A string key covers the common case; a builder
     * covers composed/transformed text (e.g. .toUpperCase(), shortcut tooltips).
     */
    bindText(el: TextElement, key: string | (() => string), options?: LocalizeOptions): () => void {
        return this.onChange(() => {
            el.text = typeof key === 'function' ? key() : this.t(key, options);
        }, el);
    }

    /** Bind a SelectInput's `.options` to a builder, preserving the current value. */
    bindOptions(el: SelectElement, build: () => Option[]): () => void {
        return this.onChange(() => {
            const value = el.value;
            el.options = build();
            el.value = value;
        }, el);
    }

    /** Translate and register a legacy localize() call for live DOM refresh. */
    legacyT(key: string, options?: LocalizeOptions): string {
        const id = `${key}\0${JSON.stringify(options ?? {})}`;
        const text = this.t(key, options);
        this.legacyRecords.set(id, { key, options, text });
        return text;
    }

    private updateLegacyDom() {
        if (typeof document === 'undefined' || !document.body || this.legacyRecords.size === 0) {
            return;
        }

        const replacements = new Map<string, string>();
        for (const record of this.legacyRecords.values()) {
            const oldText = record.text;
            const newText = this.t(record.key, record.options);
            record.text = newText;
            if (oldText !== newText) {
                replacements.set(oldText, newText);
                replacements.set(oldText.toUpperCase(), newText.toUpperCase());
            }
        }

        const pairs = Array.from(replacements.entries()).sort((a, b) => b[0].length - a[0].length);
        const replaceText = (value: string) => {
            let result = value;
            for (const [from, to] of pairs) {
                if (from && result.includes(from)) {
                    result = result.split(from).join(to);
                }
            }
            return result;
        };

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
            const value = node.nodeValue ?? '';
            const translated = replaceText(value);
            if (translated !== value) {
                node.nodeValue = translated;
            }
            node = walker.nextNode();
        }

        document.querySelectorAll<HTMLElement>('[placeholder], [title], [aria-label]').forEach((element) => {
            for (const attribute of ['placeholder', 'title', 'aria-label']) {
                const value = element.getAttribute(attribute);
                if (value !== null) {
                    const translated = replaceText(value);
                    if (translated !== value) {
                        element.setAttribute(attribute, translated);
                    }
                }
            }
        });
    }

    /** Locale-aware integer formatting. */
    formatInteger(value: number): string {
        return new Intl.NumberFormat(this.locale, {
            maximumFractionDigits: 0
        }).format(Math.round(value));
    }

    // Spaces inside "( … )" would otherwise allow awkward wraps (e.g. "Camera ("
    // on one line and "V )" on the next). NBSP keeps the shortcut group intact;
    // the normal space before '(' still allows a wrap before the parenthetical.
    formatTooltipWithShortcut(label: string, shortcut: string): string {
        if (!shortcut) {
            return label;
        }
        return `${label} (\u00A0${shortcut}\u00A0)`;
    }
}

const i18n = new Localization();

const localizeInit = () => i18n.init();
const localize = (key: string, options?: LocalizeOptions) => i18n.legacyT(key, options);
const formatInteger = (value: number) => i18n.formatInteger(value);
const formatTooltipWithShortcut = (label: string, shortcut: string) => i18n.formatTooltipWithShortcut(label, shortcut);

export { i18n, localizeInit, localize, formatInteger, formatTooltipWithShortcut };
export type { LocalizeOptions };
