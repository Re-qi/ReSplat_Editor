import { Container, Label, Element as PcuiElement, TextInput } from '@playcanvas/pcui';

import { SplatRenameOp } from '../edit-ops';
import { Element, ElementType } from '../element';
import { Events } from '../events';
import { Splat } from '../splat';
import deleteSvg from './svg/delete.svg';
import hiddenSvg from './svg/hidden.svg';
import shownSvg from './svg/shown.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class SplatItem extends Container {
    getName: () => string;
    setName: (value: string) => void;
    getSelected: () => boolean;
    setSelected: (value: boolean) => void;
    getVisible: () => boolean;
    setVisible: (value: boolean) => void;
    destroy: () => void;

    constructor(name: string, edit: TextInput, args = {}) {
        args = {
            ...args,
            class: ['splat-item', 'visible']
        };

        super(args);

        const text = new Label({
            class: 'splat-item-text',
            text: name
        });

        const visible = new PcuiElement({
            dom: createSvg(shownSvg),
            class: 'splat-item-visible'
        });

        const invisible = new PcuiElement({
            dom: createSvg(hiddenSvg),
            class: 'splat-item-visible',
            hidden: true
        });

        const remove = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'splat-item-delete'
        });

        this.append(text);
        this.append(visible);
        this.append(invisible);
        this.append(remove);

        this.getName = () => {
            return text.value;
        };

        this.setName = (value: string) => {
            text.value = value;
        };

        this.getSelected = () => {
            return this.class.contains('selected');
        };

        this.setSelected = (value: boolean) => {
            if (value !== this.selected) {
                if (value) {
                    this.class.add('selected');
                    this.emit('select', this);
                } else {
                    this.class.remove('selected');
                    this.emit('unselect', this);
                }
            }
        };

        this.getVisible = () => {
            return this.class.contains('visible');
        };

        this.setVisible = (value: boolean) => {
            if (value !== this.visible) {
                visible.hidden = !value;
                invisible.hidden = value;
                if (value) {
                    this.class.add('visible');
                    this.emit('visible', this);
                } else {
                    this.class.remove('visible');
                    this.emit('invisible', this);
                }
            }
        };

        const toggleVisible = (event: MouseEvent) => {
            event.stopPropagation();
            this.visible = !this.visible;
        };

        const handleRemove = (event: MouseEvent) => {
            event.stopPropagation();
            this.emit('removeClicked', this);
        };

        // rename on double click
        text.dom.addEventListener('dblclick', (event: MouseEvent) => {
            event.stopPropagation();

            const onblur = () => {
                this.remove(edit);
                this.emit('rename', edit.value);
                edit.input.removeEventListener('blur', onblur);
                text.hidden = false;
            };

            text.hidden = true;

            this.appendAfter(edit, text);
            edit.value = text.value;
            edit.input.addEventListener('blur', onblur);
            edit.focus();
        });

        // handle clicks
        visible.dom.addEventListener('click', toggleVisible);
        invisible.dom.addEventListener('click', toggleVisible);
        remove.dom.addEventListener('click', handleRemove);

        this.destroy = () => {
            visible.dom.removeEventListener('click', toggleVisible);
            invisible.dom.removeEventListener('click', toggleVisible);
            remove.dom.removeEventListener('click', handleRemove);
        };
    }

    set name(value: string) {
        this.setName(value);
    }

    get name() {
        return this.getName();
    }

    set selected(value) {
        this.setSelected(value);
    }

    get selected() {
        return this.getSelected();
    }

    set visible(value) {
        this.setVisible(value);
    }

    get visible() {
        return this.getVisible();
    }
}

class SplatList extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            class: 'splat-list'
        };

        super(args);

        const items = new Map<Splat, SplatItem>();
        let soloMode = false;
        const savedVisibility = new Map<Splat, boolean>();

        // Three-stage click interaction state per splat item
        // Stage 0: not clicked → first click selects
        // Stage 1: selected → second click switches gizmo or deselects
        // Stage 2: gizmo on splat → third click deselects
        const clickStages = new Map<Splat, number>();

        // Ctrl+drag selection state
        let isDragging = false;
        let dragStartSplat: Splat | null = null;

        // edit input used during renames
        const edit = new TextInput({
            id: 'splat-edit'
        });

        // Update visual state of multi-selected items
        const updateMultiSelectVisuals = () => {
            const multiSelected = events.invoke('multiSplatSelection') as Splat[];
            const multiSelectedSet = new Set(multiSelected);
            items.forEach((item, splat) => {
                if (multiSelectedSet.has(splat)) {
                    item.class.add('multi-selected');
                } else {
                    item.class.remove('multi-selected');
                }
            });
        };

        events.on('scene.elementAdded', (element: Element) => {
            if (element.type === ElementType.splat) {
                const splat = element as Splat;
                const item = new SplatItem(splat.name, edit);
                this.append(item);
                items.set(splat, item);

                if (soloMode) {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = false;
                }

                item.on('visible', () => {
                    splat.visible = true;

                    // also select it if there is no other selection
                    if (!events.invoke('selection')) {
                        events.fire('selection', splat);
                    }
                });
                item.on('invisible', () => {
                    splat.visible = false;
                });
                item.on('rename', (value: string) => {
                    events.fire('edit.add', new SplatRenameOp(splat, value));
                });
            }
        });

        events.on('scene.elementRemoved', (element: Element) => {
            if (element.type === ElementType.splat) {
                const splat = element as Splat;
                const item = items.get(splat);
                if (item) {
                    this.remove(item);
                    items.delete(splat);
                }
                savedVisibility.delete(splat);
            }
        });

        events.on('selection.changed', (selection: Element, prev: Element) => {
            items.forEach((value, key) => {
                value.selected = key === selection;
            });

            // Reset click stages for splats that don't match the new selection
            for (const [splat] of clickStages) {
                if (splat !== selection) {
                    clickStages.delete(splat);
                }
            }

            if (soloMode) {
                if (prev instanceof Splat) {
                    prev.visible = false;
                }
                if (selection instanceof Splat) {
                    selection.visible = true;
                }
            }
        });

        // Update multi-select visuals when multi-selection changes
        events.on('multiSplatSelection.changed', () => {
            updateMultiSelectVisuals();
        });

        // Reset all click stages when a shape is selected
        events.on('selection.shapeChanged', () => {
            clickStages.clear();
        });

        events.on('scene.solo', (value: boolean) => {
            soloMode = value;
            const selection = events.invoke('splatSelection');

            if (soloMode) {
                items.forEach((_item, splat) => {
                    savedVisibility.set(splat, splat.visible);
                    splat.visible = splat === selection;
                });
            } else {
                items.forEach((_item, splat) => {
                    const wasVisible = savedVisibility.get(splat);
                    splat.visible = wasVisible !== undefined ? wasVisible : true;
                });
                savedVisibility.clear();
            }
        });

        events.on('splat.name', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.name = splat.name;
            }
        });

        events.on('splat.visibility', (splat: Splat) => {
            const item = items.get(splat);
            if (item) {
                item.visible = splat.visible;
            }
        });

        this.on('click', (item: SplatItem, event: MouseEvent) => {
            for (const [key, value] of items) {
                if (item === value) {
                    if (soloMode && !key.visible) {
                        key.visible = true;
                    }

                    // Ctrl+click: toggle multi-selection
                    if (event.ctrlKey || event.metaKey) {
                        events.fire('selection.toggleSplat', key);
                        clickStages.set(key, 1);
                        break;
                    }

                    const stage = clickStages.get(key) ?? 0;
                    const gizmoOnThisSplat = events.invoke('selection') === key;
                    const groupActive = events.invoke('pointCloudGroup.activeGroup');

                    if (groupActive) {
                        // Point cloud group is active: clicking the splat-item
                        // should switch gizmo back to entity-level without
                        // deselecting gaussians. Reset stage to 0.
                        events.fire('selection', key);
                        clickStages.set(key, 1);
                    } else if (stage === 0) {
                        // Stage 1: first click → select this splat
                        events.fire('selection', key);
                        clickStages.set(key, 1);
                    } else if (stage === 1) {
                        if (!gizmoOnThisSplat) {
                            // Stage 2a: gizmo not on splat → switch gizmo to splat
                            events.fire('selection', key);
                            clickStages.set(key, 2);
                        } else {
                            // Stage 2b: gizmo already on splat → deselect
                            events.fire('selection.clearSplat');
                            clickStages.delete(key);
                        }
                    } else {
                        // Stage 3+: deselect
                        events.fire('selection.clearSplat');
                        clickStages.delete(key);
                    }

                    // Clear stages for all other splats
                    for (const [otherKey] of items) {
                        if (otherKey !== key) {
                            clickStages.delete(otherKey);
                        }
                    }

                    break;
                }
            }
        });

        // Ctrl+drag: continuous selection support
        this.dom.addEventListener('pointerdown', (e: PointerEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;

            // Find which splat item was clicked
            for (const [splat, item] of items) {
                if (item.dom.contains(e.target as Node)) {
                    isDragging = true;
                    dragStartSplat = splat;
                    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                    break;
                }
            }
        });

        this.dom.addEventListener('pointermove', (e: PointerEvent) => {
            if (!isDragging || !dragStartSplat) return;
            if (!(e.ctrlKey || e.metaKey)) {
                // Ctrl released during drag — cancel
                isDragging = false;
                dragStartSplat = null;
                return;
            }

            // Find which splat item the pointer is over
            const element = document.elementFromPoint(e.clientX, e.clientY);
            for (const [splat, item] of items) {
                if (item.dom.contains(element)) {
                    if (splat !== dragStartSplat) {
                        events.fire('selection.addSplatRange', dragStartSplat, splat);
                    }
                    break;
                }
            }
        });

        const endDrag = () => {
            isDragging = false;
            dragStartSplat = null;
        };

        this.dom.addEventListener('pointerup', endDrag);
        this.dom.addEventListener('pointercancel', endDrag);

        this.on('removeClicked', async (item: SplatItem) => {
            let splat;
            for (const [key, value] of items) {
                if (item === value) {
                    splat = key;
                    break;
                }
            }

            if (!splat) {
                return;
            }

            const result = await events.invoke('showPopup', {
                type: 'yesno',
                header: 'Remove Splat',
                message: `Are you sure you want to remove '${splat.name}' from the scene? This operation can not be undone.`
            });

            if (result?.action === 'yes') {
                splat.destroy();
            }
        });

        // Highlight current (gizmo-controlled) splat
        events.on('current.changed', (payload: any) => {
            const isSplatCurrent = payload && payload.type === 'splat' && payload.element;
            items.forEach((value, key) => {
                value.class[isSplatCurrent && key === payload.element ? 'add' : 'remove']('current');
            });
        });
    }

    protected _onAppendChild(element: PcuiElement): void {
        super._onAppendChild(element);

        if (element instanceof SplatItem) {
            element.on('click', (evt: MouseEvent) => {
                this.emit('click', element, evt);
            });

            element.on('removeClicked', () => {
                this.emit('removeClicked', element);
            });
        }
    }

    protected _onRemoveChild(element: PcuiElement): void {
        if (element instanceof SplatItem) {
            element.unbind('click');
            element.unbind('removeClicked');
        }

        super._onRemoveChild(element);
    }
}

export { SplatList, SplatItem };
