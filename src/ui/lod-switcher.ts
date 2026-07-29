import { Container, Label, SelectInput } from '@playcanvas/pcui';

import { Events } from '../events';
import { localize } from './localization';
import { Splat } from '../splat';

// LOD switcher panel shown in the scene panel. Visible only when the currently
// selected splat has a LodEditLog (i.e. imported from a multi-LOD LCC file and
// the lccFileSystem is available). Switching LOD streams the target LOD data
// from the original file and replays all recorded spatial operations on it.
class LodSwitcher extends Container {
    private selectInput: SelectInput;
    private switching = false;

    constructor(events: Events) {
        super({
            id: 'lod-switcher',
            class: 'lod-switcher',
            hidden: true
        });

        const label = new Label({
            text: localize('lod-switcher.label'),
            class: 'lod-switcher-label'
        });

        this.selectInput = new SelectInput({
            class: 'lod-switcher-select',
            type: 'number',
            allowNull: false,
            options: []
        });

        this.append(label);
        this.append(this.selectInput);

        // Update visibility + options when the selected splat changes
        const refresh = (splat: Splat | null) => {
            if (splat && splat.lodEditLog && splat.lccFileSystem && splat.lodCounts.length > 1) {
                this.hidden = false;
                this.selectInput.options = splat.lodCounts.map((count, i) => ({
                    v: i,
                    t: `LOD ${i} (${count.toLocaleString()} ${localize('popup.lod-select-splats')})`
                }));
                this.selectInput.value = String(splat.currentLodIndex);
            } else {
                this.hidden = true;
                this.selectInput.options = [];
            }
        };

        events.on('selection.changed', (selection: any) => {
            refresh(selection instanceof Splat ? selection : null);
        });

        events.on('lod.switched', () => {
            const splat = events.invoke('splatSelection') as Splat;
            refresh(splat ?? null);
        });

        // Trigger LOD switch when the user picks a different LOD
        this.selectInput.on('change', (value: string) => {
            if (this.switching || value == null || value === '') return;
            const targetLod = parseInt(value, 10);
            const splat = events.invoke('splatSelection') as Splat;
            if (!splat || targetLod === splat.currentLodIndex) return;
            this.switching = true;
            events.invoke('lod.switch', targetLod).catch((e: Error) => {
                console.error('[lod-switcher] lod.switch failed:', e);
            }).finally(() => {
                this.switching = false;
                // Use the current selection, not the captured splat —
                // otherwise refresh restores the old splat's LOD index
                // and triggers an infinite LOD-switch loop.
                const current = events.invoke('splatSelection') as Splat | null;
                refresh(current);
            });
        });

        // Initial state
        const initial = events.invoke('splatSelection') as Splat | null;
        refresh(initial);
    }
}

export { LodSwitcher };
