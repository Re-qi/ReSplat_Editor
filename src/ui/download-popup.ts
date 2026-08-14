import { Button, Container, Label } from '@playcanvas/pcui';

import { localize } from './localization';
import { openUrl } from '../open-url';

// Built-in download mirrors for the desktop app.
const GITHUB_URL = 'https://github.com/Re-qi/ReSplat_Editor/releases';
const QUARK_URL = 'https://pan.quark.cn/s/128e4200b891';

/**
 * Download dialog shown when clicking the bottom-right version label or the
 * "软件版" link in the web-version notes. Lists the GitHub and Quark download
 * mirrors; each row opens the mirror (and copies its link). A 确定 button at
 * the bottom (and Escape / click-outside) closes the dialog.
 */
class DownloadPopup extends Container {
    show: () => void;
    hide: () => void;

    constructor(args = {}) {
        args = {
            ...args,
            id: 'download-popup',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        // Escape closes the dialog
        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.hidden = true;
            }
            e.stopPropagation();
        });

        // Close when clicking outside the dialog
        this.on('click', () => {
            this.hidden = true;
        });

        const dialog = new Container({
            id: 'download-dialog'
        });

        // Prevent clicks inside the dialog from closing it
        dialog.on('click', (event: MouseEvent) => {
            event.stopPropagation();
        });

        // Header
        const header = new Label({
            id: 'download-header',
            text: localize('download-popup.header')
        });

        // Content: one row per download mirror
        const content = new Container({
            id: 'download-content'
        });

        const makeOption = (labelKey: string, url: string) => {
            const row = new Container({
                class: 'download-option'
            });
            const name = new Label({
                class: 'download-option-name',
                text: localize(labelKey)
            });
            const link = new Label({
                class: 'download-option-url',
                text: url
            });
            row.append(name);
            row.append(link);
            row.dom.addEventListener('click', () => {
                openUrl(url);
                navigator.clipboard.writeText(url).catch(() => {});
            });
            return row;
        };

        content.append(makeOption('download-popup.github', GITHUB_URL));
        content.append(makeOption('download-popup.quark', QUARK_URL));

        // Footer: 确定 closes the dialog
        const footer = new Container({
            id: 'download-footer'
        });

        const okButton = new Button({
            class: 'download-ok',
            text: localize('download-popup.ok')
        });
        okButton.on('click', () => {
            this.hidden = true;
        });
        footer.append(okButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        this.show = () => {
            this.hidden = false;
            this.dom.focus();
        };

        this.hide = () => {
            this.hidden = true;
        };
    }
}

export { DownloadPopup };
