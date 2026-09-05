import { Events } from '../events';

interface Tool {
    activate: () => void;
    deactivate: () => void;
}

type EditorMode = 'edit' | 'paint';

class ToolManager {
    tools = new Map<string, Tool>();
    private toolModes = new Map<string, EditorMode>();
    events: Events;
    active: string | null = null;
    mode: EditorMode = 'edit';
    lastEditTool = 'move';

    constructor(events: Events) {
        this.events = events;

        this.events.on('tool.deactivate', () => {
            if (this.active === 'paint') {
                if (this.events.invoke('paint.strokeActive')) {
                    this.events.fire('paint.cancelStroke');
                } else {
                    this.setMode('edit');
                }
            } else {
                this.activate(null);
            }
        });

        this.events.function('tool.active', () => {
            return this.active;
        });

        this.events.function('mode.active', () => {
            return this.mode;
        });

        this.events.on('mode.set', (mode: EditorMode) => {
            this.setMode(mode);
        });

        this.events.on('mode.togglePaint', () => {
            this.setMode(this.mode === 'paint' ? 'edit' : 'paint');
        });

        let coordSpace: 'local' | 'world' = 'world';

        const setCoordSpace = (space: 'local' | 'world') => {
            if (space !== coordSpace) {
                coordSpace = space;
                events.fire('tool.coordSpace', coordSpace);
            }
        };

        events.function('tool.coordSpace', () => {
            return coordSpace;
        });

        events.on('tool.setCoordSpace', (value: 'local' | 'world') => {
            setCoordSpace(value);
        });

        events.on('tool.toggleCoordSpace', () => {
            setCoordSpace(coordSpace === 'local' ? 'world' : 'local');
        });
    }

    register(name: string, tool: Tool, mode: EditorMode = 'edit') {
        this.tools.set(name, tool);
        this.toolModes.set(name, mode);

        this.events.on(`tool.${name}`, () => {
            if (this.toolModes.get(name) !== this.mode) return;
            this.activate(name);
        });
    }

    get(toolName: string) {
        return (toolName && this.tools.get(toolName)) ?? null;
    }

    setMode(mode: EditorMode) {
        if (mode === 'paint') {
            if (this.active === 'paint') return;
            if (this.active && this.active !== 'paint') {
                this.lastEditTool = this.active;
            }
            this.activate('paint');
        } else if (this.active === 'paint' || !this.active) {
            this.activate(this.tools.has(this.lastEditTool) ? this.lastEditTool : 'move');
        }
    }

    activate(toolName: string | null) {
        if (toolName === this.active) {
            // re-activating the currently active tool deactivates it
            if (toolName === 'paint') {
                this.setMode('edit');
            } else if (toolName) {
                this.activate(null);
            }
        } else {
            // deactive old tool
            if (this.active) {
                const tool = this.tools.get(this.active);
                tool.deactivate();
                this.events.fire(`tool.${this.active}.deactivated`);
                this.events.fire('tool.deactivated', this.active);
            }

            this.active = toolName;

            // activate the new
            if (this.active) {
                const tool = this.tools.get(this.active);
                tool.activate();
            }

            if (this.active && this.active !== 'paint') {
                this.lastEditTool = this.active;
            }

            const nextMode: EditorMode = this.active === 'paint' ? 'paint' : 'edit';
            if (nextMode !== this.mode) {
                this.events.fire('mode.willChange', nextMode, this.mode);
                this.mode = nextMode;
                this.events.fire('mode.changed', this.mode);
            }

            this.events.fire(`tool.${toolName}.activated`);
            this.events.fire('tool.activated', toolName);
        }
    }
}

export { ToolManager };
export type { EditorMode };
