import { Container, Label, Element as PcuiElement, Button, TextInput } from '@playcanvas/pcui';

import { SelectOp } from '../edit-ops';
import { Events } from '../events';
import { IndexRanges } from '../index-ranges';
import { Splat } from '../splat';
import { State } from '../splat-state';
import deleteSvg from './svg/delete.svg';
import gripSvg from './svg/grip.svg';
import newGroupSvg from './svg/new.svg';
import { localize } from './localization';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

interface PointCloudGroupData {
    name: string;
    splat: Splat;
    ranges: IndexRanges;
}

class PointCloudGroupItem extends Container {
    groupData: PointCloudGroupData;
    onSelect: ((item: PointCloudGroupItem) => void) | null = null;

    constructor(
        groupData: PointCloudGroupData,
        tooltips: Tooltips,
        editInput: TextInput,
        onDeleteGroup: (gd: PointCloudGroupData) => void
    ) {
        super({
            class: 'point-cloud-group-item'
        });

        this.groupData = groupData;

        const nameLabel = new Label({
            class: 'point-cloud-group-item-name',
            text: groupData.name
        });

        const deleteBtn = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'point-cloud-group-delete-btn'
        });

        this.append(nameLabel);
        this.append(deleteBtn);

        // Click on the item to select it (like splat-item)
        this.dom.addEventListener('click', (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (target.closest('button')) return;
            event.stopPropagation();
            if (this.onSelect) {
                this.onSelect(this);
            }
        });

        // Rename on double click
        nameLabel.dom.addEventListener('dblclick', (event: MouseEvent) => {
            event.stopPropagation();
            nameLabel.hidden = true;

            editInput.value = groupData.name;
            this.appendAfter(editInput, nameLabel);

            const onBlur = () => {
                const newName = editInput.value.trim() || groupData.name;
                groupData.name = newName;
                nameLabel.text = newName;
                this.remove(editInput);
                nameLabel.hidden = false;
                editInput.input.removeEventListener('blur', onBlur);
            };

            editInput.input.addEventListener('blur', onBlur);
            editInput.focus();
        });

        deleteBtn.dom.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            onDeleteGroup(groupData);
        });

        tooltips.register(deleteBtn, localize('tooltip.point-cloud-group.delete'), 'bottom');
    }

    get selected() {
        return this.class.contains('selected');
    }

    set selected(value: boolean) {
        if (value) {
            this.class.add('selected');
        } else {
            this.class.remove('selected');
        }
    }
}

class PointCloudGroup extends Container {
    private groups: PointCloudGroupData[] = [];
    private groupItems: PointCloudGroupItem[] = [];
    private listContainer: Container;
    private editInput: TextInput;
    private groupCounter = 1;
    private events: Events;
    private tooltips: Tooltips;
    private currentSplat: Splat | null = null;
    private _activeGroup = false;
    private selectedGroupData: PointCloudGroupData | null = null;
    private toolbar: Container;
    private toolbarSelectBtn: Button;
    private toolbarAddBtn: Button;
    private toolbarRemoveBtn: Button;

    constructor(events: Events, tooltips: Tooltips, canvasContainer: Container, args = {}) {
        args = {
            ...args,
            id: 'point-cloud-group',
            class: 'point-cloud-group-section'
        };

        super(args);

        this.events = events;
        this.tooltips = tooltips;

        // Initially hidden until a splat is selected
        this.hidden = true;

        // Header
        const header = new Container({
            class: 'panel-header'
        });

        const icon = new PcuiElement({
            dom: createSvg(gripSvg),
            class: 'panel-header-icon'
        });

        const label = new Label({
            text: localize('panel.point-cloud-group'),
            class: 'panel-header-label'
        });

        const newGroupBtn = new Container({
            class: 'panel-header-button'
        });
        newGroupBtn.dom.appendChild(createSvg(newGroupSvg));

        header.append(icon);
        header.append(label);
        header.append(newGroupBtn);

        // List container
        this.listContainer = new Container({
            class: 'point-cloud-group-list'
        });

        this.append(header);
        this.append(this.listContainer);

        // Edit input for renaming
        this.editInput = new TextInput({
            class: 'point-cloud-group-edit'
        });

        tooltips.register(newGroupBtn, localize('tooltip.point-cloud-group.new'), 'bottom');

        // Create toolbar for selected group
        this.toolbar = new Container({
            class: 'point-cloud-group-toolbar',
            hidden: true
        });

        // Prevent canvas from intercepting pointer events on toolbar buttons
        this.toolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        this.toolbarSelectBtn = new Button({
            text: localize('toolbar.point-cloud-group.select'),
            class: 'point-cloud-group-toolbar-btn'
        });

        this.toolbarAddBtn = new Button({
            text: localize('toolbar.point-cloud-group.add'),
            class: 'point-cloud-group-toolbar-btn'
        });

        this.toolbarRemoveBtn = new Button({
            text: localize('toolbar.point-cloud-group.remove'),
            class: 'point-cloud-group-toolbar-btn'
        });

        this.toolbar.append(this.toolbarSelectBtn);
        this.toolbar.append(this.toolbarAddBtn);
        this.toolbar.append(this.toolbarRemoveBtn);

        canvasContainer.append(this.toolbar);

        // Toolbar button handlers - use dom pointerdown (not pcui click) so they
        // work even when a selection tool is active intercepting pointer events
        this.toolbarSelectBtn.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!this.selectedGroupData) return;
            this.handleGroupSelect(this.selectedGroupData);
        });

        this.toolbarAddBtn.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!this.selectedGroupData) return;
            this.handleGroupAddTo(this.selectedGroupData);
        });

        this.toolbarRemoveBtn.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            if (!this.selectedGroupData) return;
            this.handleGroupRemoveFrom(this.selectedGroupData);
        });

        // Register a function so splat rendering can check if a group is active
        events.function('pointCloudGroup.activeGroup', () => {
            return this._activeGroup;
        });

        // Get serializable group data for a specific splat
        events.function('pointCloudGroup.getGroupsForSplat', (splat: Splat) => {
            return this.groups
                .filter(g => g.splat === splat)
                .map(g => {
                    const ids: number[] = [];
                    g.ranges.forEach(i => ids.push(i));
                    return {
                        name: g.name,
                        indices: new Uint32Array(ids).sort()
                    };
                });
        });

        // Add groups for a specific splat from serialized data
        events.on('pointCloudGroup.addGroupsForSplat', (splat: Splat, groupsData: { name: string; indices: Uint32Array }[]) => {
            for (const gd of groupsData) {
                const numSplats = splat.splatData.numSplats;
                const indexSet = new Set<number>();
                for (let i = 0; i < gd.indices.length; i++) {
                    indexSet.add(gd.indices[i]);
                }
                const ranges = IndexRanges.fromPredicate(numSplats, (i: number) => indexSet.has(i));

                const groupData: PointCloudGroupData = {
                    name: gd.name,
                    splat: splat,
                    ranges: ranges
                };

                this.groups.push(groupData);
            }

            // Re-render if this splat is currently displayed
            if (this.currentSplat === splat) {
                this.renderGroupsForSplat(splat);
            }
        });

        // Selection changed: show groups only for currently selected splat
        const updateVisibility = (splat: any) => {
            if (splat instanceof Splat) {
                const changed = this.currentSplat !== splat;
                this.currentSplat = splat;
                this.hidden = false;
                // Only re-render if splat actually changed
                if (changed) {
                    this.renderGroupsForSplat(splat);
                }
            } else {
                this.currentSplat = null;
                this.hidden = true;
                this.listContainer.clear();
                this.groupItems = [];
                // Update _activeGroup state when selection is cleared
                if (this._activeGroup) {
                    this._activeGroup = false;
                }
            }
        };

        events.on('selection.changed', (selection: any) => {
            updateVisibility(selection);
        });

        // Initialize visibility if a splat is already selected
        const initialSelection = events.invoke('splatSelection');
        if (initialSelection instanceof Splat) {
            updateVisibility(initialSelection);
        }

        // Create new group from current selection
        newGroupBtn.dom.addEventListener('click', () => {
            const splat = this.currentSplat;
            if (!splat) return;

            const state = splat.state.data;
            let selectedRanges: IndexRanges | null = null;

            if (splat.numSelected > 0) {
                selectedRanges = IndexRanges.fromPredicate(
                    splat.splatData.numSplats,
                    (i: number) => (state[i] & State.selected) !== 0
                );
            } else {
                selectedRanges = IndexRanges.fromPredicate(
                    splat.splatData.numSplats,
                    (i: number) => (state[i] & State.deleted) === 0
                );
            }

            if (!selectedRanges || selectedRanges.empty) return;

            const groupData: PointCloudGroupData = {
                name: `${localize('panel.point-cloud-group')} ${this.groupCounter++}`,
                splat: splat,
                ranges: selectedRanges
            };

            this.groups.push(groupData);
            const item = this.addGroupItem(groupData);
            this.groupItems.push(item);
        });

        // Scene cleared - clear all groups
        events.on('scene.clear', () => {
            this.groups = [];
            this.listContainer.clear();
            this.currentSplat = null;
            this.hidden = true;
        });

        // Splat removed - remove associated groups
        events.on('scene.elementRemoved', (element: any) => {
            if (element instanceof Splat) {
                const before = this.groups.length;
                this.groups = this.groups.filter(g => g.splat !== element);
                if (this.groups.length !== before && this.currentSplat === element) {
                    this.renderGroupsForSplat(this.currentSplat);
                }
            }
        });
    }

    private renderGroupsForSplat(splat: Splat) {
        // 保存当前选中的组
        const selectedGroups = this.groupItems.filter(item => item.selected).map(item => item.groupData);
        
        this.listContainer.clear();
        this.groupItems = [];
        const splatGroups = this.groups.filter(g => g.splat === splat);
        for (const groupData of splatGroups) {
            const item = this.addGroupItem(groupData);
            // 恢复选中状态
            if (selectedGroups.includes(groupData)) {
                item.selected = true;
            }
            this.groupItems.push(item);
        }
        // 不在这里调用 updateActiveGroupState()，让调用者决定
    }

    private updateActiveGroupState() {
        let hasSelected = false;
        for (const item of this.groupItems) {
            if (item.selected) {
                hasSelected = true;
                break;
            }
        }
        if (hasSelected !== this._activeGroup) {
            this._activeGroup = hasSelected;
            // 触发重新渲染 - 使用 camera.bound 事件来强制重新渲染
            this.events.fire('camera.bound');
        }
    }

    private handleGroupSelect(gd: PointCloudGroupData) {
        const splat = gd.splat;
        const { ranges } = gd;
        const sortedIds: number[] = [];
        ranges.forEach((i: number) => sortedIds.push(i));
        this.events.fire('edit.add', new SelectOp(splat, 'set', new Uint32Array(sortedIds)));
    }

    private handleGroupAddTo(gd: PointCloudGroupData) {
        const splat = gd.splat;
        const state = splat.state.data;
        if (splat.numSelected === 0) return;

        const existing = new Set<number>();
        gd.ranges.forEach((i: number) => existing.add(i));

        for (let i = 0; i < state.length; i++) {
            if ((state[i] & State.selected) !== 0) {
                existing.add(i);
            }
        }

        gd.ranges = IndexRanges.fromPredicate(
            splat.splatData.numSplats,
            (i: number) => existing.has(i)
        );
    }

    private handleGroupRemoveFrom(gd: PointCloudGroupData) {
        const splat = gd.splat;
        const state = splat.state.data;
        if (splat.numSelected === 0) return;

        const toRemove = new Set<number>();
        for (let i = 0; i < state.length; i++) {
            if ((state[i] & State.selected) !== 0) {
                toRemove.add(i);
            }
        }

        const currentRanges = new Set<number>();
        gd.ranges.forEach((i: number) => currentRanges.add(i));

        gd.ranges = IndexRanges.fromPredicate(
            splat.splatData.numSplats,
            (i: number) => currentRanges.has(i) && !toRemove.has(i)
        );
    }

    private handleGroupDelete(gd: PointCloudGroupData) {
        const idx = this.groups.indexOf(gd);
        if (idx !== -1) {
            this.groups.splice(idx, 1);
        }
        if (this.selectedGroupData === gd) {
            this.selectedGroupData = null;
            this.toolbar.hidden = true;
        }
        this.renderGroupsForSplat(this.currentSplat!);
    }

    private addGroupItem(groupData: PointCloudGroupData): PointCloudGroupItem {
        const item = new PointCloudGroupItem(
            groupData,
            this.tooltips,
            this.editInput,
            (gd: PointCloudGroupData) => this.handleGroupDelete(gd)
        );
        item.onSelect = (clicked: PointCloudGroupItem) => {
            // Deselect all other group items
            for (const el of this.groupItems) {
                if (el !== clicked) {
                    el.selected = false;
                }
            }

            const wasSelected = clicked.selected;
            clicked.selected = !wasSelected;

            if (!wasSelected) {
                // Group just became selected - select the group's gaussians,
                // set origin to boundCenter, and enable show bound
                const { splat, ranges } = groupData;
                const sortedIds: number[] = [];
                ranges.forEach((i: number) => sortedIds.push(i));
                
                // Store selected group data for toolbar
                this.selectedGroupData = groupData;
                this.toolbar.hidden = false;
                
                // Listen for state change to update active group state after selection bound is computed
                const onStateChanged = () => {
                    // Directly set _activeGroup based on clicked item's state
                    // Don't rely on groupItems array as it might be in inconsistent state
                    this._activeGroup = clicked.selected;
                    // Force a re-render to update the boundary display
                    this.events.invoke('queue', () => {
                        // Trigger a render update
                        return Promise.resolve();
                    });
                    this.events.off('splat.stateChanged', onStateChanged);
                };
                this.events.on('splat.stateChanged', onStateChanged);

                // Fire the selection operation - SelectOp.do() will call updateState()
                // which internally calls updateLocalBounds() to update selectionBound
                this.events.fire('edit.add', new SelectOp(splat, 'set', new Uint32Array(sortedIds)));

                // Force origin to boundCenter
                this.events.fire('pivot.setOrigin', 'boundCenter');

                // Enable show bound if not already enabled
                if (!this.events.invoke('camera.bound')) {
                    this.events.fire('camera.setBound', true);
                }
            } else {
                // Group deselected - update state immediately
                this.selectedGroupData = null;
                this.toolbar.hidden = true;
                this.updateActiveGroupState();
            }
        };
        this.listContainer.append(item);
        return item;
    }
}

export { PointCloudGroup };