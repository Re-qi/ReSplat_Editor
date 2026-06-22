import { platform } from 'playcanvas';

import { Events } from './events';
import { Shortcuts, ShortcutBinding } from './shortcuts';

// Mac uses different symbols for modifier keys
const isMac = platform.name === 'osx';

// Default shortcut bindings - the source of truth for key mappings
const defaultShortcuts: Record<string, ShortcutBinding> = {
    // Navigation
    'camera.reset': { keys: ['f'], shift: 'required' },
    'camera.focus': { keys: ['f'] },
    'camera.toggleControlMode': { keys: ['v'] },
    'select.duplicate': { keys: ['d'], ctrl: 'required' },
    'select.separate': { keys: ['p'] },
    'select.merge': { keys: ['j'], ctrl: 'required' },

    // Show
    'camera.cycleMode': { keys: ['Tab'] },
    'grid.toggleVisible': { keys: ['g'] },
    'select.hide': { keys: ['h'] },
    'select.unhide': { keys: ['h'], shift: 'required' },

    // Playback
    'timeline.togglePlay': { keys: [' '] },
    'timeline.prevFrame': { keys: [','], repeat: true },
    'timeline.nextFrame': { keys: ['.'], repeat: true },
    'timeline.prevKey': { keys: ['<'], shift: 'optional', repeat: true },
    'timeline.nextKey': { keys: ['>'], shift: 'optional', repeat: true },
    'track.addKey': { keys: ['Enter'] },
    'track.removeKey': { keys: ['Enter'], shift: 'required' },

    // Selection
    'select.all': { keys: ['a'], ctrl: 'required', capture: true },
    'select.none': { keys: ['a'], ctrl: 'required', shift: 'required', capture: true },
    'select.invert': { keys: ['i'], ctrl: 'required' },
    'select.delete': { keys: ['Delete', 'Backspace'] },

    // Tools
    'tool.move': { keys: ['w'] },
    'tool.rotate': { keys: ['e'] },
    'tool.scale': { keys: ['r'] },
    'tool.rectSelection': { keys: ['q'] },
    'tool.lassoSelection': { keys: ['l'] },
    'tool.polygonSelection': { keys: ['p'] },
    'tool.brushSelection': { keys: ['b'] },
    'tool.floodSelection': { keys: ['o'] },
    'tool.eyedropperSelection': { keys: ['e'], ctrl: 'required', capture: true },
    'tool.brushSelection.smaller': { keys: ['['], repeat: true },
    'tool.brushSelection.bigger': { keys: [']'], repeat: true },
    'tool.deactivate': { keys: ['Escape'] },
    'tool.toggleCoordSpace': { keys: ['c'], shift: 'required' },

    // Other
    'edit.undo': { keys: ['z'], ctrl: 'required', repeat: true, capture: true },
    'edit.redo': { keys: ['z'], ctrl: 'required', shift: 'required', repeat: true, capture: true },
    'timelinePanel.toggle': { keys: ['t'], ctrl: 'required', capture: true },
    'bottomToolbar.toggle': { keys: ['t'] },
    'scenePanel.toggle': { keys: ['n'] },

    'camera.toggleOverlay': { keys: ['z'], alt: 'required', capture: true },

    // Camera fly keys - handled by main.ts for conditional mouse state checking
    // (W/A/S/D/Q/E are intercepted there to switch tools when no mouse is pressed)
};

class ShortcutManager {
    private bindings: Record<string, ShortcutBinding>;

    constructor(events: Events) {
        // Clone the defaults so they can be modified without affecting the originals
        this.bindings = {};
        for (const id in defaultShortcuts) {
            this.bindings[id] = { ...defaultShortcuts[id] };
        }

        // Create shortcuts and register all bindings
        const shortcuts = new Shortcuts(events);
        for (const id in this.bindings) {
            const binding = this.bindings[id];
            shortcuts.register({
                event: id,
                keys: binding.keys,
                codes: binding.codes,
                ctrl: binding.ctrl,
                shift: binding.shift,
                alt: binding.alt,
                held: binding.held,
                repeat: binding.repeat,
                capture: binding.capture
            });
        }
    }

    /**
     * Get a shortcut binding by its event ID.
     */
    get(id: string): ShortcutBinding | undefined {
        return this.bindings[id];
    }

    /**
     * Format a shortcut for display (e.g., "Ctrl + Shift + Z" or "⌘⇧Z" on Mac).
     */
    formatShortcut(id: string): string {
        const binding = this.bindings[id];
        if (!binding) return '';

        const parts: string[] = [];

        // Use Mac symbols: ⌘ (Cmd), ⌥ (Option), ⇧ (Shift)
        if (binding.ctrl === 'required') parts.push(isMac ? '⌘' : 'Ctrl');
        if (binding.alt === 'required') parts.push(isMac ? '⌥' : 'Alt');
        if (binding.shift === 'required') parts.push(isMac ? '⇧' : 'Shift');

        // Get the first key or code for display
        let keyDisplay = binding.keys?.[0] ?? binding.codes?.[0];
        if (!keyDisplay) return '';

        if (keyDisplay === ' ') {
            keyDisplay = 'Space';
        } else if (keyDisplay === 'Escape') {
            keyDisplay = 'Esc';
        } else if (keyDisplay.startsWith('Key')) {
            // Physical key codes like 'KeyW' -> 'W'
            keyDisplay = keyDisplay.slice(3);
        } else if (keyDisplay.length === 1) {
            keyDisplay = keyDisplay.toUpperCase();
        }

        parts.push(keyDisplay);

        return isMac ? parts.join(' ') : parts.join(' + ');
    }
}

export { ShortcutManager };
