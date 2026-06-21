import { Container, Label, Element as PcuiElement } from '@playcanvas/pcui';

import { BlockingPlane } from '../blocking-plane';
import { BoxShape } from '../box-shape';
import { Element } from '../element';
import { Events } from '../events';
import { SphereShape } from '../sphere-shape';
import deleteSvg from './svg/delete.svg';
import hiddenSvg from './svg/hidden.svg';
import shownSvg from './svg/shown.svg';
import selectSphereSvg from './svg/select-sphere.svg';
import { localize } from './localization';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

class WrapperList extends Container {
    private header: Container;
    private listContainer: Container;
    private sphereItems = new Map<SphereShape, Container>();
    private boxItems = new Map<BoxShape, Container>();
    private blockingPlaneItems = new Map<BlockingPlane, Container>();
    private sphereCount = 0;
    private boxCount = 0;
    private blockingPlaneCount = 0;

    private updateVisibility() {
        const total = this.sphereItems.size + this.boxItems.size + this.blockingPlaneItems.size;
        this.hidden = total === 0;
    }

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'wrapper-list',
            class: 'wrapper-list-section'
        };

        super(args);

        this.hidden = true;

        // Header
        this.header = new Container({
            class: 'panel-header'
        });

        const icon = new PcuiElement({
            dom: createSvg(selectSphereSvg),
            class: 'panel-header-icon'
        });

        const label = new Label({
            text: localize('panel.wrappers'),
            class: 'panel-header-label'
        });

        this.header.append(icon);
        this.header.append(label);

        // List container
        this.listContainer = new Container({
            class: 'wrapper-list-list'
        });

        this.append(this.header);
        this.append(this.listContainer);

        // Shared helper for adding shape items
        const addShapeItem = (
            shape: SphereShape | BoxShape | BlockingPlane,
            labelText: string,
            shapeMap: Map<any, Container>
        ) => {
            const shapeItem = new Container({
                class: ['wrapper-list-item', 'visible']
            });

            const nameLabel = new Label({
                class: 'wrapper-list-item-name',
                text: labelText
            });

            const visibleIcon = new PcuiElement({
                dom: createSvg(shownSvg),
                class: 'wrapper-list-item-visible'
            });

            const invisibleIcon = new PcuiElement({
                dom: createSvg(hiddenSvg),
                class: 'wrapper-list-item-visible',
                hidden: true
            });

            const removeBtn = new PcuiElement({
                dom: createSvg(deleteSvg),
                class: 'wrapper-list-item-delete'
            });

            shapeItem.append(nameLabel);
            shapeItem.append(visibleIcon);
            shapeItem.append(invisibleIcon);
            shapeItem.append(removeBtn);
            this.listContainer.append(shapeItem);
            shapeMap.set(shape, shapeItem);

            // Visibility toggle
            const toggleVisible = (e: MouseEvent) => {
                e.stopPropagation();
                const wasVisible = (shape as any).pivot.enabled;
                (shape as any).pivot.enabled = !wasVisible;
                const nowVisible = !wasVisible;
                visibleIcon.hidden = !nowVisible;
                invisibleIcon.hidden = nowVisible;
                if (nowVisible) {
                    shapeItem.class.add('visible');
                } else {
                    shapeItem.class.remove('visible');
                }
            };
            visibleIcon.dom.addEventListener('click', toggleVisible);
            invisibleIcon.dom.addEventListener('click', toggleVisible);

            // Click to select
            shapeItem.dom.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                events.fire('selection', shape as any);

                // Auto-activate the corresponding tool
                const currentTool = events.invoke('tool.active') as string;
                const isTransformTool = ['move', 'rotate', 'scale'].includes(currentTool);
                if (shape instanceof SphereShape && !isTransformTool && currentTool !== 'sphereSelection') {
                    events.fire('tool.sphereSelection');
                } else if (shape instanceof BoxShape && !isTransformTool && currentTool !== 'boxSelection') {
                    events.fire('tool.boxSelection');
                }
            });

            // Delete button
            removeBtn.dom.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                shape.destroy();
            });
        };

        events.on('scene.elementAdded', (element: Element) => {
            if (element instanceof SphereShape) {
                this.sphereCount++;
                addShapeItem(element, `包裹球 #${this.sphereCount}`, this.sphereItems);
            } else if (element instanceof BoxShape) {
                this.boxCount++;
                addShapeItem(element, `包裹盒 #${this.boxCount}`, this.boxItems);
            } else if (element instanceof BlockingPlane) {
                this.blockingPlaneCount++;
                addShapeItem(element, `阻挡平面 #${this.blockingPlaneCount}`, this.blockingPlaneItems);
            }
            this.updateVisibility();
        });

        events.on('scene.elementRemoved', (element: Element) => {
            if (element instanceof SphereShape) {
                const item = this.sphereItems.get(element);
                if (item) {
                    this.listContainer.remove(item);
                    this.sphereItems.delete(element);
                }
            } else if (element instanceof BoxShape) {
                const item = this.boxItems.get(element);
                if (item) {
                    this.listContainer.remove(item);
                    this.boxItems.delete(element);
                }
            } else if (element instanceof BlockingPlane) {
                const item = this.blockingPlaneItems.get(element);
                if (item) {
                    this.listContainer.remove(item);
                    this.blockingPlaneItems.delete(element);
                }
            }
            this.updateVisibility();
        });

        // Highlight selected shape
        events.on('selection.shapeChanged', (selection: Element) => {
            this.sphereItems.forEach((item, sphere) => {
                item.class[sphere === selection ? 'add' : 'remove']('selected');
            });
            this.boxItems.forEach((item, box) => {
                item.class[box === selection ? 'add' : 'remove']('selected');
            });
            this.blockingPlaneItems.forEach((item, plane) => {
                item.class[plane === selection ? 'add' : 'remove']('selected');
            });
        });
    }
}

export { WrapperList };
