import { Button, Container, Element, Label, TextInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import squaresUnite from './svg/squares-unite.svg';

const createSvg = (svgString: string, args = {}) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement,
        ...args
    });
};

const getBasename = (filePath: string) => {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
};

const getBasenameWithoutExt = (filePath: string) => {
    const base = getBasename(filePath);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.substring(0, dot) : base;
};

type CombineLcc2Result = {
    files: string[];
    name: string;
};

class CombineLcc2Popup extends Container {
    show: () => Promise<CombineLcc2Result | null>;
    hide: () => void;
    destroy: () => void;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'combine-lcc2-popup',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        const dialog = new Container({ id: 'dialog' });

        // header
        const header = new Container({ id: 'header' });
        const headerIcon = createSvg(squaresUnite, { id: 'icon' });
        const headerText = new Label({ id: 'header', text: localize('popup.combine-lcc2.header') });
        header.append(headerIcon);
        header.append(headerText);

        // content
        const content = new Container({ id: 'content' });

        const hint = new Label({ class: 'hint', text: localize('popup.combine-lcc2.hint') });

        const fileList = new Container({ id: 'file-list' });

        const emptyLabel = new Label({ class: 'empty', text: localize('popup.combine-lcc2.empty') });

        const addButton = new Button({
            class: 'button',
            text: localize('popup.combine-lcc2.add-files')
        });

        const nameRow = new Container({ class: 'row' });
        const nameLabel = new Label({
            class: 'label',
            text: localize('popup.combine-lcc2.filename')
        });
        const nameInput = new TextInput({
            class: 'text-input',
            placeholder: localize('popup.combine-lcc2.filename-placeholder')
        });
        nameRow.append(nameLabel);
        nameRow.append(nameInput);

        content.append(hint);
        content.append(fileList);
        content.append(emptyLabel);
        content.append(addButton);
        content.append(nameRow);

        // footer
        const footer = new Container({ id: 'footer' });

        const cancelButton = new Button({
            class: 'button',
            text: localize('popup.cancel')
        });

        const exportButton = new Button({
            class: 'button',
            text: localize('popup.combine-lcc2.export')
        });

        footer.append(cancelButton);
        footer.append(exportButton);

        dialog.append(header);
        dialog.append(content);
        dialog.append(footer);

        this.append(dialog);

        // state
        const files: string[] = [];
        const rows: Container[] = [];

        const renderList = () => {
            rows.forEach((row) => {
                fileList.remove(row);
                row.destroy();
            });
            rows.length = 0;

            emptyLabel.hidden = files.length > 0;
            fileList.hidden = files.length === 0;

            files.forEach((filePath, i) => {
                const row = new Container({ class: 'file-row' });
                const indexLabel = new Label({ class: 'index', text: `${i + 1}` });
                const nameLabel = new Label({ class: 'name', text: getBasename(filePath) });
                row.append(indexLabel);
                row.append(nameLabel);

                row.dom.addEventListener('pointerdown', e => onRowPointerDown(e as PointerEvent, i));

                fileList.append(row);
                rows.push(row);
            });

            if (rows.length > 0) {
                rows.forEach(row => row.dom.classList.remove('dragging'));
            }
        };

        // Drag immediately to reorder (no long-press required).
        let dragIndex = -1;

        const onRowPointerDown = (e: PointerEvent, index: number) => {
            if (e.button !== 0) return;
            e.preventDefault();

            dragIndex = index;
            rows[index]?.dom.classList.add('dragging');
            window.addEventListener('pointermove', onDragMove);
            window.addEventListener('pointerup', onDragEnd);
            window.addEventListener('pointercancel', onDragEnd);
        };

        const onDragMove = (e: PointerEvent) => {
            e.preventDefault();
            if (dragIndex < 0) return;

            let target = dragIndex;
            for (let i = 0; i < rows.length; ++i) {
                const rect = rows[i].dom.getBoundingClientRect();
                if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
                    target = i;
                    break;
                }
            }

            if (target !== dragIndex) {
                const [moved] = files.splice(dragIndex, 1);
                files.splice(target, 0, moved);
                dragIndex = target;
                renderList();
                rows[dragIndex]?.dom.classList.add('dragging');
            }
        };

        const onDragEnd = () => {
            dragIndex = -1;
            rows.forEach(row => row.dom.classList.remove('dragging'));
            window.removeEventListener('pointermove', onDragMove);
            window.removeEventListener('pointerup', onDragEnd);
            window.removeEventListener('pointercancel', onDragEnd);
        };

        // add files
        addButton.on('click', async () => {
            try {
                const electronAPI = (window as any).electronAPI;
                let paths: string[] | null = null;

                if (electronAPI?.openFileDialog) {
                    paths = await electronAPI.openFileDialog({
                        title: localize('popup.combine-lcc2.add-files'),
                        filters: [{
                            name: 'Gaussian Splat',
                            extensions: ['ply', 'splat', 'sog', 'ksplat', 'spz']
                        }]
                    });
                } else {
                    paths = await new Promise<string[] | null>((resolve) => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.multiple = true;
                        input.accept = '.ply,.splat,.sog,.ksplat,.spz';
                        input.onchange = () => {
                            resolve(Array.from(input.files ?? []).map(f => (f as any).path || f.name));
                        };
                        input.click();
                    });
                }

                if (paths && paths.length > 0) {
                    files.push(...paths);
                    if (nameInput.value.trim() === '') {
                        nameInput.value = getBasenameWithoutExt(files[0]);
                    }
                    renderList();
                }
            } catch (e) {
                // cancelled file dialog — keep the popup open
            }
        });

        // export / cancel
        let onCancel: () => void;
        let onExport: () => void;

        cancelButton.on('click', () => onCancel());

        exportButton.on('click', async () => {
            if (files.length < 2) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: localize('popup.combine-lcc2.header'),
                    message: localize('popup.combine-lcc2.need-more')
                });
                return;
            }
            onExport();
        });

        const reset = () => {
            files.length = 0;
            nameInput.value = '';
            renderList();
        };

        this.show = () => {
            reset();

            this.hidden = false;
            this.dom.focus();

            return new Promise<CombineLcc2Result | null>((resolve) => {
                onCancel = () => {
                    resolve(null);
                };

                onExport = () => {
                    const name = nameInput.value.trim() || (files.length > 0 ? getBasenameWithoutExt(files[0]) : 'combined-lod');
                    resolve({ files: files.slice(), name });
                };
            }).finally(() => {
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

export { CombineLcc2Popup };
