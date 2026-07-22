import { Container, Element, Label } from '@playcanvas/pcui';

class Spinner extends Container {
    private _label: Label;

    constructor(args = {}) {
        args = {
            ...args,
            id: 'spinner-container',
            hidden: true
        };

        super(args);

        this.dom.tabIndex = 0;

        const spinner = new Element({
            dom: 'div',
            class: 'spinner'
        });

        this.append(spinner);

        this._label = new Label({
            id: 'spinner-text',
            hidden: true
        });
        this.append(this._label);

        this.dom.addEventListener('keydown', (event) => {
            if (this.hidden) return;
            event.stopPropagation();
            event.preventDefault();
        });
    }

    set text(value: string) {
        if (value) {
            this._label.text = value;
            this._label.hidden = false;
        } else {
            this._label.hidden = true;
        }
    }

    get text(): string {
        return this._label.text;
    }
}

export { Spinner };
