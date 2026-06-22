import { Button, Container, Element, Label, TextInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { Splat } from '../splat';
import { localize } from './localization';
import wrenchIcon from './svg/wrench.svg';

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

type FixPlyResult = {
    source: 'current' | 'file';
    file?: File;
    splat?: Splat;
};

class FixPlyDialog extends Container {
    show: () => Promise<FixPlyResult | null>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'fix-ply-dialog',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog' });

        // header

        const header = new Container({ id: 'header' });
        const headerIcon = createSvg(wrenchIcon, { id: 'icon' });
        const headerText = new Label({ id: 'header', text: localize('popup.fix-ply.header') });
        header.append(headerIcon);
        header.append(headerText);

        // content

        const content = new Container({ id: 'content' });

        // file path input row
        const filePathRow = new Container({ class: 'row' });
        const filePathLabel = new Label({
            class: 'label',
            text: localize('popup.fix-ply.file')
        });
        const filePathInput = new TextInput({
            class: 'text-input',
            placeholder: localize('popup.fix-ply.file-placeholder'),
            readOnly: true
        });
        const selectFileButton = new Button({
            class: 'button',
            text: localize('popup.fix-ply.select-file')
        });
        filePathRow.append(filePathLabel);
        filePathRow.append(filePathInput);
        filePathRow.append(selectFileButton);

        content.append(filePathRow);

        // footer

        const footer = new Container({ id: 'footer' });

        const cancelButton = new Button({
            class: 'button',
            text: localize('popup.fix-ply.cancel')
        });

        const useCurrentButton = new Button({
            class: 'button',
            text: localize('popup.fix-ply.use-current')
        });

        const fixButton = new Button({
            class: 'button',
            text: localize('popup.fix-ply.fix')
        });

        footer.append(cancelButton);
        footer.append(useCurrentButton);
        footer.append(fixButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        // state

        let selectedFile: File | null = null;
        let useCurrentActive = false;

        const updateHighlight = () => {
            if (useCurrentActive) {
                useCurrentButton.dom.classList.add('active');
            } else {
                useCurrentButton.dom.classList.remove('active');
            }
        };

        const clearCurrentHighlight = () => {
            useCurrentActive = false;
            updateHighlight();
        };

        // "使用当前文件" button: reads from the selected splat in scene manager
        useCurrentButton.on('click', () => {
            const splat = events.invoke('splatSelection') as Splat | null;
            if (!splat) {
                return;
            }
            useCurrentActive = !useCurrentActive;
            if (useCurrentActive) {
                selectedFile = null;
                filePathInput.value = splat.name || splat.filename || '';
            } else {
                filePathInput.value = selectedFile ? selectedFile.name : '';
            }
            updateHighlight();
        });

        // "选择文件" button: opens file picker for external PLY
        selectFileButton.on('click', async () => {
            try {
                if (window.showOpenFilePicker) {
                    const [handle] = await window.showOpenFilePicker({
                        id: 'ReSplatFixPlySelect',
                        multiple: false,
                        types: [{
                            description: 'PLY Files',
                            accept: { 'application/octet-stream': ['.ply'] }
                        }]
                    });
                    selectedFile = await handle.getFile();
                } else {
                    selectedFile = await new Promise<File | null>((resolve) => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = '.ply';
                        input.onchange = () => resolve(input.files?.[0] ?? null);
                        input.click();
                    });
                }

                if (selectedFile) {
                    clearCurrentHighlight();
                    filePathInput.value = selectedFile.name;
                }
            } catch (e) {
                // user cancelled
            }
        });

        let onCancel: () => void;
        let onFix: () => void;

        cancelButton.on('click', () => onCancel());
        fixButton.on('click', () => onFix());

        const keydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onCancel();
            }
        };

        // reset UI state
        const reset = () => {
            selectedFile = null;
            useCurrentActive = false;
            updateHighlight();

            // try to detect currently selected splat
            const splat = events.invoke('splatSelection') as Splat | null;
            if (splat) {
                filePathInput.value = splat.name || splat.filename || '';
                useCurrentActive = true;
                updateHighlight();
            } else {
                filePathInput.value = '';
            }
        };

        this.show = () => {
            reset();

            this.hidden = false;
            document.addEventListener('keydown', keydown);
            this.dom.focus();

            return new Promise<FixPlyResult | null>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onFix = () => {
                    if (useCurrentActive) {
                        const splat = events.invoke('splatSelection') as Splat | null;
                        if (splat) {
                            resolve({ source: 'current', splat });
                            return;
                        }
                    }

                    if (selectedFile) {
                        resolve({ source: 'file', file: selectedFile });
                        return;
                    }
                };
            }).finally(() => {
                document.removeEventListener('keydown', keydown);
                this.hide();
            });
        };

        this.hide = () => {
            this.hidden = true;
        };

        this.destroy = () => {
            this.hide();
            super.destroy();
        };
    }
}

export { FixPlyDialog, FixPlyResult };
