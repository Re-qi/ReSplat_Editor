import { Container, Label, Element as PcuiElement, Button, TextInput } from '@playcanvas/pcui';

import { AddGroupOp, DeleteGroupOp, ModifyGroupRangesOp, ReplaceSelectionOp } from '../edit-ops';
import { Events } from '../events';
import { IndexRanges } from '../index-ranges';
import { Splat } from '../splat';
import { State } from '../splat-state';
import { localize } from './localization';
import deleteSvg from './svg/delete.svg';
import gripSvg from './svg/grip.svg';
import newGroupSvg from './svg/new.svg';
import scanEyeSvg from './svg/scan-eye.svg';
import shownOnlySvg from './svg/shown-only.svg';
import shownOnly2Svg from './svg/shown-only2.svg';
import { Tooltips } from './tooltips';
import { addVerticalListResizeHandle } from './vertical-list-resize';

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

    private soloEl: PcuiElement;
    private soloActiveEl: PcuiElement;
    private editEl: PcuiElement;

    constructor(
        groupData: PointCloudGroupData,
        tooltips: Tooltips,
        editInput: TextInput,
        onDeleteGroup: (gd: PointCloudGroupData) => void,
        onSoloToggle: (item: PointCloudGroupItem, additive: boolean) => void,
        onEditToggle: (item: PointCloudGroupItem, additive: boolean) => void
    ) {
        super({
            class: 'point-cloud-group-item'
        });

        this.groupData = groupData;

        const nameLabel = new Label({
            class: 'point-cloud-group-item-name',
            text: groupData.name
        });

        // Solo (isolate) button: shown-only.svg normally, shown-only2.svg
        // when active. Clicking it hides all other point cloud group items.
        this.soloEl = new PcuiElement({
            dom: createSvg(shownOnlySvg),
            class: 'point-cloud-group-solo-btn'
        });

        this.soloActiveEl = new PcuiElement({
            dom: createSvg(shownOnly2Svg),
            class: ['point-cloud-group-solo-btn', 'active'],
            hidden: true
        });

        // Independent edit button (scan-eye.svg): desaturates gaussians
        // outside this group (and other edit-enabled groups).
        this.editEl = new PcuiElement({
            dom: createSvg(scanEyeSvg),
            class: 'point-cloud-group-edit-btn'
        });

        const deleteBtn = new PcuiElement({
            dom: createSvg(deleteSvg),
            class: 'point-cloud-group-delete-btn'
        });

        this.append(nameLabel);
        this.append(this.soloEl);
        this.append(this.soloActiveEl);
        this.append(this.editEl);
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

        const toggleSolo = (event: MouseEvent) => {
            event.stopPropagation();
            onSoloToggle(this, event.shiftKey);
        };

        deleteBtn.dom.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            onDeleteGroup(groupData);
        });

        this.soloEl.dom.addEventListener('click', toggleSolo);
        this.soloActiveEl.dom.addEventListener('click', toggleSolo);

        this.editEl.dom.addEventListener('click', (event: MouseEvent) => {
            event.stopPropagation();
            onEditToggle(this, event.shiftKey);
        });

        tooltips.register(deleteBtn, localize('tooltip.point-cloud-group.delete'), 'bottom');
        tooltips.register(this.soloEl, localize('tooltip.point-cloud-group.solo'), 'bottom');
        tooltips.register(this.soloActiveEl, localize('tooltip.point-cloud-group.solo'), 'bottom');
        tooltips.register(this.editEl, localize('tooltip.point-cloud-group.edit'), 'bottom');
    }

    set selected(value: boolean) {
        if (value) {
            this.class.add('selected');
        } else {
            this.class.remove('selected');
        }
    }

    get selected() {
        return this.class.contains('selected');
    }

    set solo(value: boolean) {
        if (value !== this.solo) {
            this.soloEl.hidden = value;
            this.soloActiveEl.hidden = !value;
            if (value) {
                this.class.add('solo');
            } else {
                this.class.remove('solo');
            }
        }
    }

    get solo() {
        return this.class.contains('solo');
    }

    set editActive(value: boolean) {
        if (value !== this.editActive) {
            if (value) {
                this.editEl.class.add('active');
            } else {
                this.editEl.class.remove('active');
            }
        }
    }

    get editActive() {
        return this.editEl.class.contains('active');
    }
}

class PointCloudGroup extends Container {
    private groups: PointCloudGroupData[] = [];
    private groupItems: PointCloudGroupItem[] = [];
    private listContainer: Container;
    private editInput: TextInput;
    private events: Events;
    private tooltips: Tooltips;
    private currentSplat: Splat | null = null;
    private _activeGroup = false;
    private _needsGaussianSelection = false;
    private selectedGroupData: PointCloudGroupData | null = null;
    private soloedGroups: Set<PointCloudGroupData> = new Set();
    private editedGroups: Set<PointCloudGroupData> = new Set();
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
        addVerticalListResizeHandle(this.listContainer.dom, { disableWhenEmpty: true });

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
            this.selectGroupGaussians(this.selectedGroupData);
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

        // Register a function so selection tools can check if independent edit
        // is active (gaussians outside edited groups must not be selectable).
        events.function('pointCloudGroup.editActive', () => {
            return this.editedGroups.size > 0;
        });

        // Get serializable group data for a specific splat
        events.function('pointCloudGroup.getGroupsForSplat', (splat: Splat) => {
            return this.groups
            .filter(g => g.splat === splat)
            .map((g) => {
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

        // Expose internals for EditOp serialization/deserialization
        events.function('pointCloudGroup.getGroupsArray', () => this.groups);
        events.function('pointCloudGroup.setSelectedGroupData', (value: PointCloudGroupData | null) => {
            this.setSelectedGroupData(value);
        });
        events.function('pointCloudGroup.getRenderCallback', (splat: Splat) => {
            return () => this.renderGroupsForSplat(splat);
        });

        // Selection changed: show groups only for currently selected splat
        const updateVisibility = (splat: any) => {
            if (splat instanceof Splat) {
                const changed = this.currentSplat !== splat;
                this.currentSplat = splat;
                this.hidden = false;

                // When splat selection changes (e.g. splat-item clicked),
                // deactivate any active point cloud group so gizmo switches
                // back to entity-level control.
                if (this._activeGroup) {
                    this._activeGroup = false;
                    this._needsGaussianSelection = false;
                    for (const item of this.groupItems) {
                        item.selected = false;
                    }
                    this.setSelectedGroupData(null);

                    // Re-trigger transform-handler evaluation now that
                    // _activeGroup is false. Because transform-handler registers
                    // its selection.changed listener before us, its update()
                    // already ran while _activeGroup was still true.
                    this.events.fire('splat.stateChanged', splat);
                }

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
                    this._needsGaussianSelection = false;
                }
            }
        };

        events.on('selection.changed', (selection: any) => {
            updateVisibility(selection);
        });

        // Painting always targets a complete Gaussian file. If a point-cloud
        // group is current when paint mode starts, promote its owning Splat to
        // the scene selection; updateVisibility then clears the group-current
        // state while preserving the selected Gaussian bits themselves.
        let prePaintGroup: PointCloudGroupData | null = null;
        events.on('mode.changed', (mode: 'edit' | 'paint') => {
            if (mode === 'paint') {
                prePaintGroup = this._activeGroup ? this.selectedGroupData : null;
                if (prePaintGroup) events.fire('selection', prePaintGroup.splat);
                return;
            }

            const group = prePaintGroup;
            prePaintGroup = null;
            if (!group || !this.groups.includes(group) || !group.splat.scene || !group.splat.visible) return;

            for (const item of this.groupItems) {
                item.selected = item.groupData === group;
            }
            this.setSelectedGroupData(group);
            this._activeGroup = true;
            this._needsGaussianSelection = false;
            this.events.fire('splat.stateChanged', group.splat);
        });

        // When a shape (wrapper) is selected, deactivate the group so the
        // gizmo switches from group mode to shape control.
        events.on('selection.shapeChanged', () => {
            console.log('[point-cloud-group] selection.shapeChanged: _activeGroup was', this._activeGroup);
            if (this._activeGroup) {
                this._activeGroup = false;
                this._needsGaussianSelection = false;
                for (const item of this.groupItems) {
                    item.selected = false;
                }
                this.setSelectedGroupData(null);
            }
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
                name: `${localize('panel.point-cloud-group')} ${this.getNextGroupNumber()}`,
                splat: splat,
                ranges: selectedRanges
            };

            // Do the work eagerly, then fire edit-op for undo support
            this.groups.push(groupData);
            const item = this.addGroupItem(groupData);
            this.groupItems.push(item);

            this.events.fire('edit.add', new AddGroupOp(
                this.groups, groupData,
                () => this.renderGroupsForSplat(splat),
                true
            ));
        });

        // Scene cleared - clear all groups
        events.on('scene.clear', () => {
            this.groups = [];
            this.listContainer.clear();
            this.currentSplat = null;
            this.soloedGroups.clear();
            this.editedGroups.clear();
            this.hidden = true;
        });

        // Splat removed - remove associated groups
        events.on('scene.elementRemoved', (element: any) => {
            if (element instanceof Splat) {
                // Drop solo/edit state for groups belonging to the removed splat.
                // No mask clear needed: the splat is being destroyed.
                for (const gd of Array.from(this.soloedGroups)) {
                    if (gd.splat === element) this.soloedGroups.delete(gd);
                }
                for (const gd of Array.from(this.editedGroups)) {
                    if (gd.splat === element) this.editedGroups.delete(gd);
                }
                const before = this.groups.length;
                this.groups = this.groups.filter(g => g.splat !== element);
                if (this.groups.length !== before && this.currentSplat === element) {
                    this.renderGroupsForSplat(this.currentSplat);
                }
            }
        });

        // Highlight current (gizmo-controlled) group
        events.on('current.changed', (payload: any) => {
            const isGroupCurrent = payload && payload.type === 'group';
            this.groupItems.forEach((item) => {
                item.class[isGroupCurrent && item.groupData === this.selectedGroupData ? 'add' : 'remove']('current');
            });
        });
    }

    private getNextGroupNumber(): number {
        let maxNum = 0;
        const prefix = localize('panel.point-cloud-group');
        for (const g of this.groups) {
            if (g.name.startsWith(prefix)) {
                const num = parseInt(g.name.substring(prefix.length).trim(), 10);
                if (!isNaN(num)) {
                    maxNum = Math.max(maxNum, num);
                }
            }
        }
        return maxNum + 1;
    }

    private renderGroupsForSplat(splat: Splat) {
        // 保存当前选中的组
        const selectedGroups = this.groupItems.filter(item => item.selected).map(item => item.groupData);

        this.listContainer.clear();
        this.groupItems = [];
        const splatGroups = this.groups.filter(g => g.splat === splat);

        // 清理已不存在（被删除或属于其他 splat）的独显/编辑组
        const staleSplats = new Set<Splat>();
        for (const gd of Array.from(this.soloedGroups)) {
            if (splatGroups.indexOf(gd) === -1) {
                this.soloedGroups.delete(gd);
                staleSplats.add(gd.splat);
            }
        }
        for (const gd of Array.from(this.editedGroups)) {
            if (splatGroups.indexOf(gd) === -1) {
                this.editedGroups.delete(gd);
                staleSplats.add(gd.splat);
            }
        }

        // 复位被清理 splat 的视口遮罩（当前 splat 稍后统一同步）
        for (const s of staleSplats) {
            if (s !== splat) {
                s.setSoloMask(null);
                s.setDesaturateMask(null);
            }
        }

        for (const groupData of splatGroups) {
            const item = this.addGroupItem(groupData);
            // 恢复选中状态
            if (selectedGroups.includes(groupData)) {
                item.selected = true;
            }
            // 恢复独显/编辑状态：仅在3D视口中生效，UI列表保持全部可见
            if (this.soloedGroups.has(groupData)) {
                item.solo = true;
            }
            if (this.editedGroups.has(groupData)) {
                item.editActive = true;
            }
            this.groupItems.push(item);
        }

        // 组范围可能变化（增删点云），重新同步视口遮罩
        splat.setSoloMask(this.soloedGroups.size > 0 ? this.collectRanges(this.soloedGroups) : null);
        splat.setDesaturateMask(this.editedGroups.size > 0 ? this.collectRanges(this.editedGroups) : null);
        // 不在这里调用 updateActiveGroupState()，让调用者决定
    }

    private collectRanges(groups: Set<PointCloudGroupData>): IndexRanges[] {
        const result: IndexRanges[] = [];
        groups.forEach(g => result.push(g.ranges));
        return result;
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
            if (!hasSelected) {
                this._needsGaussianSelection = false;
            }
            // 触发重新渲染 - 使用 camera.bound 事件来强制重新渲染
            this.events.fire('camera.bound');
        }
    }

    private setSelectedGroupData(value: PointCloudGroupData | null) {
        this.selectedGroupData = value;
        this.toolbar.hidden = value === null;
    }

    /**
     *  Fire a ReplaceSelectionOp that clears all selected gaussians then
     *  selects only the group's indices. Unlike SelectOp 'set' (TOGGLE-based),
     *  this guarantees a visible state change every time — all state queries
     *  happen at execution time, not construction time.
     */
    private selectGroupGaussians(gd: PointCloudGroupData) {
        const { ranges } = gd;
        const sortedIds: number[] = [];
        ranges.forEach((i: number) => sortedIds.push(i));
        this.events.fire('edit.add', new ReplaceSelectionOp(gd.splat, new Uint32Array(sortedIds)));
    }

    private handleGroupAddTo(gd: PointCloudGroupData) {
        const splat = gd.splat;
        const state = splat.state.data;
        if (splat.numSelected === 0) return;

        const oldRanges = gd.ranges;

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

        this.events.fire('edit.add', new ModifyGroupRangesOp(
            gd, oldRanges, gd.ranges,
            () => this.renderGroupsForSplat(this.currentSplat!),
            true
        ));
    }

    private handleGroupRemoveFrom(gd: PointCloudGroupData) {
        const splat = gd.splat;
        const state = splat.state.data;
        if (splat.numSelected === 0) return;

        const oldRanges = gd.ranges;

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

        this.events.fire('edit.add', new ModifyGroupRangesOp(
            gd, oldRanges, gd.ranges,
            () => this.renderGroupsForSplat(this.currentSplat!),
            true
        ));
    }

    private handleGroupDelete(gd: PointCloudGroupData) {
        const idx = this.groups.indexOf(gd);
        if (idx !== -1) {
            this.groups.splice(idx, 1);
        }
        if (this.selectedGroupData === gd) {
            this.setSelectedGroupData(null);
        }
        // 被删除的组若处于独显/编辑状态，从集合移除（遮罩由 renderGroupsForSplat 同步）
        this.soloedGroups.delete(gd);
        this.editedGroups.delete(gd);
        this.renderGroupsForSplat(this.currentSplat!);

        const splat = this.currentSplat!;
        this.events.fire('edit.add', new DeleteGroupOp(
            this.groups, gd,
            (value: PointCloudGroupData | null) => this.setSelectedGroupData(value),
            () => this.renderGroupsForSplat(splat),
            true
        ));
    }

    // Solo (isolate) toggle: enabled groups are the only gaussians shown in
    // the 3D viewport. The UI list stays fully visible.
    // Shift-click adds/removes a group without affecting the others.
    private handleGroupSoloToggle(item: PointCloudGroupItem, additive: boolean) {
        const gd = item.groupData;

        if (additive) {
            if (this.soloedGroups.has(gd)) {
                this.soloedGroups.delete(gd);
                item.solo = false;
            } else {
                this.soloedGroups.add(gd);
                item.solo = true;
            }
        } else {
            if (this.soloedGroups.size === 1 && this.soloedGroups.has(gd)) {
                // Toggling off the only soloed group: restore all gaussians.
                this.soloedGroups.clear();
                item.solo = false;
            } else {
                // Replace the soloed set with just this group.
                for (const other of this.groupItems) {
                    other.solo = false;
                }
                this.soloedGroups.clear();
                this.soloedGroups.add(gd);
                item.solo = true;
            }
        }

        gd.splat.setSoloMask(this.soloedGroups.size > 0 ? this.collectRanges(this.soloedGroups) : null);
    }

    // Independent edit toggle: gaussians outside the enabled groups are
    // desaturated (saturation -> 0). Shift-click adds/removes a group without
    // affecting the others.
    private handleGroupEditToggle(item: PointCloudGroupItem, additive: boolean) {
        const gd = item.groupData;

        if (additive) {
            if (this.editedGroups.has(gd)) {
                this.editedGroups.delete(gd);
                item.editActive = false;
            } else {
                this.editedGroups.add(gd);
                item.editActive = true;
            }
        } else {
            if (this.editedGroups.size === 1 && this.editedGroups.has(gd)) {
                // Toggling off the only edited group: restore full saturation.
                this.editedGroups.clear();
                item.editActive = false;
            } else {
                // Replace the edited set with just this group.
                for (const other of this.groupItems) {
                    other.editActive = false;
                }
                this.editedGroups.clear();
                this.editedGroups.add(gd);
                item.editActive = true;
            }
        }

        gd.splat.setDesaturateMask(this.editedGroups.size > 0 ? this.collectRanges(this.editedGroups) : null);
    }

    private addGroupItem(groupData: PointCloudGroupData): PointCloudGroupItem {
        const item = new PointCloudGroupItem(
            groupData,
            this.tooltips,
            this.editInput,
            this.handleGroupDelete.bind(this),
            this.handleGroupSoloToggle.bind(this),
            this.handleGroupEditToggle.bind(this)
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
                // Store selected group data for toolbar
                this.setSelectedGroupData(groupData);

                // Set _activeGroup BEFORE firing the selection op so that when
                // splat.stateChanged fires, transform-handler sees _activeGroup === true
                // and pushes SplatsTransformHandler instead of EntityTransformHandler.
                this._activeGroup = true;

                // Listen for state change to force re-render after selection bound is computed
                const onStateChanged = () => {
                    // Force a re-render to update the boundary display
                    this.events.invoke('queue', () => {
                        // Trigger a render update
                        return Promise.resolve();
                    });
                    this.events.off('splat.stateChanged', onStateChanged);
                };
                this.events.on('splat.stateChanged', onStateChanged);

                // When switching from a wrapper shape, activate the group
                // without auto-selecting gaussians. The second click on the
                // same group will select them.
                if (this.events.invoke('shapeSelection')) {
                    this._needsGaussianSelection = true;
                    // Fire stateChanged so computeCurrent() picks up _activeGroup
                    if (this.currentSplat) {
                        this.events.fire('splat.stateChanged', this.currentSplat);
                    }
                } else {
                    this._needsGaussianSelection = false;
                    this.selectGroupGaussians(groupData);

                    // Force origin to boundCenter
                    this.events.fire('pivot.setOrigin', 'boundCenter');

                    // Enable show bound if not already enabled
                    if (!this.events.invoke('camera.bound')) {
                        this.events.fire('camera.setBound', true);
                    }
                }
            } else {
                // Group already selected.
                // If gaussians haven't been selected yet (shape→group first
                // click), select them now on the second click.
                if (this._needsGaussianSelection) {
                    this._needsGaussianSelection = false;

                    const onStateChanged = () => {
                        this.events.invoke('queue', () => Promise.resolve());
                        this.events.off('splat.stateChanged', onStateChanged);
                    };
                    this.events.on('splat.stateChanged', onStateChanged);

                    this.selectGroupGaussians(groupData);
                    this.events.fire('pivot.setOrigin', 'boundCenter');
                    if (!this.events.invoke('camera.bound')) {
                        this.events.fire('camera.setBound', true);
                    }
                } else {
                    // Group deselected - update state immediately
                    this.setSelectedGroupData(null);
                    this.updateActiveGroupState();
                }
            }
        };
        this.listContainer.append(item);
        return item;
    }
}

export { PointCloudGroup };
