import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import Backend from 'i18next-http-backend';

const localizeInit = () => {
    return i18next
    .use(Backend)
    .use(LanguageDetector)
    .init({
        detection: {
            order: ['querystring', /* 'cookie', 'localStorage', 'sessionStorage',*/ 'navigator', 'htmlTag']
        },
        backend: {
            loadPath: './static/locales/{{lng}}.json'
        },
        supportedLngs: ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'ru', 'zh-CN'],
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false
        }
    });
};

interface LocalizeOptions {
    ellipsis?: boolean;
}

const localize = (key: string, options?: LocalizeOptions): string => {
    let text = i18next.t(key);

    if (options?.ellipsis) text += '...';

    return text;
};

const getLocale = (): string => {
    return i18next.language || 'en';
};

const formatInteger = (value: number): string => {
    return new Intl.NumberFormat(getLocale(), {
        maximumFractionDigits: 0
    }).format(Math.round(value));
};

// Spaces inside "( … )" would otherwise allow awkward wraps (e.g. "Camera ("
// on one line and "V )" on the next). NBSP keeps the shortcut group intact;
// the normal space before '(' still allows a wrap before the parenthetical.
const formatTooltipWithShortcut = (label: string, shortcut: string): string => {
    if (!shortcut) {
        return label;
    }
    return `${label} (\u00A0${shortcut}\u00A0)`;
};

export { localizeInit, localize, formatInteger, formatTooltipWithShortcut };
export type { LocalizeOptions };
