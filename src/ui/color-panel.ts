import { ColorPicker, Container, Label, SliderInput } from '@playcanvas/pcui';
import { Color } from 'playcanvas';

import { Events } from '../events';
import { localize } from './localization';
import { Tooltips } from './tooltips';
import { SetSplatColorAdjustmentOp } from '../edit-ops';
import { Splat } from '../splat';
import { SphereShape } from '../sphere-shape';
import { BoxShape } from '../box-shape';
import { BlockingPlane } from '../blocking-plane';
import { Element } from '../element';

// pcui slider doesn't include start and end events
class MyFancySliderInput extends SliderInput {
    _onSlideStart(pageX: number) {
        super._onSlideStart(pageX);
        this.emit('slide:start');
    }

    _onSlideEnd(pageX: number) {
        super._onSlideEnd(pageX);
        this.emit('slide:end');
    }
}

class ColorPanel extends Container {
    constructor(events: Events, tooltips: Tooltips, args: any = {}) {
        const embedded = args.embedded;
        args = {
            ...args,
            id: 'color-panel',
            class: embedded ? '' : 'panel',
            hidden: embedded ? false : true
        };

        super(args);

        // stop pointer events bubbling
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // header

        const header = new Container({
            class: 'panel-header'
        });

        const icon = new Label({
            class: 'panel-header-icon',
            text: '\uE146'
        });

        const label = new Label({
            class: 'panel-header-label',
            text: localize('panel.colors')
        });

        header.append(icon);
        header.append(label);

        const reset = new Label({
            class: 'panel-header-button',
            text: '\uE304'
        });

        header.append(reset);

        // tint

        const tintRow = new Container({
            class: 'color-panel-row'
        });

        const tintLabel = new Label({
            text: localize('panel.colors.tint'),
            class: 'color-panel-row-label'
        });

        const tintPicker = new ColorPicker({
            class: 'color-panel-row-picker',
            value: [1, 1, 1]
        });

        tintRow.append(tintLabel);
        tintRow.append(tintPicker);

        // temperature

        const temperatureRow = new Container({
            class: 'color-panel-row'
        });

        const temperatureLabel = new Label({
            text: localize('panel.colors.temperature'),
            class: 'color-panel-row-label'
        });

        const temperatureSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -0.5,
            max: 0.5,
            step: 0.005,
            value: 0
        });

        temperatureRow.append(temperatureLabel);
        temperatureRow.append(temperatureSlider);

        // saturation

        const saturationRow = new Container({
            class: 'color-panel-row'
        });

        const saturationLabel = new Label({
            text: localize('panel.colors.saturation'),
            class: 'color-panel-row-label'
        });

        const saturationSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 2,
            step: 0.1,
            value: 1
        });

        saturationRow.append(saturationLabel);
        saturationRow.append(saturationSlider);

        // brightness

        const brightnessRow = new Container({
            class: 'color-panel-row'
        });

        const brightnessLabel = new Label({
            text: localize('panel.colors.brightness'),
            class: 'color-panel-row-label'
        });

        const brightnessSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -1,
            max: 1,
            step: 0.1,
            value: 1
        });

        brightnessRow.append(brightnessLabel);
        brightnessRow.append(brightnessSlider);

        // black point

        const blackPointRow = new Container({
            class: 'color-panel-row'
        });

        const blackPointLabel = new Label({
            text: localize('panel.colors.black-point'),
            class: 'color-panel-row-label'
        });

        const blackPointSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 0
        });

        blackPointRow.append(blackPointLabel);
        blackPointRow.append(blackPointSlider);

        // white point

        const whitePointRow = new Container({
            class: 'color-panel-row'
        });

        const whitePointLabel = new Label({
            text: localize('panel.colors.white-point'),
            class: 'color-panel-row-label'
        });

        const whitePointSlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: 0,
            max: 1,
            step: 0.01,
            value: 1
        });

        whitePointRow.append(whitePointLabel);
        whitePointRow.append(whitePointSlider);

        // transparency

        const transparencyRow = new Container({
            class: 'color-panel-row'
        });

        const transparencyLabel = new Label({
            text: localize('panel.colors.transparency'),
            class: 'color-panel-row-label'
        });

        const transparencySlider = new MyFancySliderInput({
            class: 'color-panel-row-slider',
            min: -6,
            max: 6,
            step: 0.01,
            value: 1
        });

        transparencyRow.append(transparencyLabel);
        transparencyRow.append(transparencySlider);

        this.append(header);
        this.append(tintRow);
        this.append(temperatureRow);
        this.append(saturationRow);
        this.append(brightnessRow);
        this.append(blackPointRow);
        this.append(whitePointRow);
        this.append(transparencyRow);

        // handle ui updates

        let suppress = false;
        let selected: Splat = null;
        let selectedShape: SphereShape | BoxShape | BlockingPlane | null = null;
        let op: SetSplatColorAdjustmentOp = null;

        const updateUIFromState = (splat: Splat) => {
            if (suppress) return;
            suppress = true;
            tintPicker.value = splat ? [splat.tintClr.r, splat.tintClr.g, splat.tintClr.b] : [1, 1, 1];
            temperatureSlider.value = splat ? splat.temperature : 0;
            saturationSlider.value = splat ? splat.saturation : 0;
            brightnessSlider.value = splat ? splat.brightness : 0;
            blackPointSlider.value = splat ? splat.blackPoint : 0;
            whitePointSlider.value = splat ? splat.whitePoint : 1;
            transparencySlider.value = splat ? Math.log(splat.transparency) : 0;
            suppress = false;
        };

        const updateShapeUIFromState = (shape: SphereShape | BoxShape | BlockingPlane | null) => {
            if (suppress) return;
            suppress = true;
            if (shape) {
                tintPicker.value = [shape.color.r, shape.color.g, shape.color.b];
            } else {
                tintPicker.value = [1, 1, 1];
            }
            // Hide splat-specific controls when shape is selected
            const isShape = !!shape;
            temperatureRow.hidden = isShape;
            saturationRow.hidden = isShape;
            brightnessRow.hidden = isShape;
            blackPointRow.hidden = isShape;
            whitePointRow.hidden = isShape;
            transparencyRow.hidden = isShape;
            suppress = false;
        };

        const startShapeOp = () => {
            if (selectedShape) {
                // Directly modify shape color, no undo op for now
                // Could add ShapeColorOp later if needed
            }
        };

        const endShapeOp = () => {
            // No undo op registration for shape color
        };

        const start = () => {
            if (selected) {
                op = new SetSplatColorAdjustmentOp({
                    splat: selected,
                    newState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency
                    },
                    oldState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency
                    }
                });
            }
        };

        const end = () => {
            if (op) {
                const { newState } = op;
                newState.tintClr.set(tintPicker.value[0], tintPicker.value[1], tintPicker.value[2]);
                newState.temperature = temperatureSlider.value;
                newState.saturation = saturationSlider.value;
                newState.brightness = brightnessSlider.value;
                newState.blackPoint = blackPointSlider.value;
                newState.whitePoint = whitePointSlider.value;
                newState.transparency = Math.exp(transparencySlider.value);
                events.fire('edit.add', op);
                op = null;
            }
        };

        const updateOp = (setFunc: (op: SetSplatColorAdjustmentOp) => void) => {
            if (!suppress) {
                suppress = true;
                if (op) {
                    setFunc(op);
                    op.do();
                } else if (selected) {
                    start();
                    setFunc(op);
                    op.do();
                    end();
                }
                suppress = false;
            }
        };

        [temperatureSlider, saturationSlider, brightnessSlider, blackPointSlider, whitePointSlider, transparencySlider].forEach((slider) => {
            slider.on('slide:start', start);
            slider.on('slide:end', end);
        });
        tintPicker.on('picker:color:start', () => {
            if (selectedShape) {
                startShapeOp();
            } else {
                start();
            }
        });
        tintPicker.on('picker:color:end', () => {
            if (selectedShape) {
                endShapeOp();
            } else {
                end();
            }
        });

        tintPicker.on('change', (value: number[]) => {
            // Handle shape color change
            if (selectedShape) {
                selectedShape.color = new Color(value[0], value[1], value[2]);
                return;
            }
            // Handle splat color change
            updateOp((op) => {
                op.newState.tintClr.set(value[0], value[1], value[2]);
            });
        });

        temperatureSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.temperature = value;
            });
        });

        saturationSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.saturation = value;
            });
        });

        brightnessSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.brightness = value;
            });
        });

        blackPointSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.blackPoint = value;
            });

            if (value > whitePointSlider.value) {
                whitePointSlider.value = value;
            }
        });

        whitePointSlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.whitePoint = value;
            });

            if (value < blackPointSlider.value) {
                blackPointSlider.value = value;
            }
        });

        transparencySlider.on('change', (value: number) => {
            updateOp((op) => {
                op.newState.transparency = Math.exp(value);
            });
        });

        reset.on('click', () => {
            if (selectedShape) {
                selectedShape.color = new Color(1, 1, 1);
                updateShapeUIFromState(selectedShape);
            } else if (selected) {
                const op = new SetSplatColorAdjustmentOp({
                    splat: selected,
                    newState: {
                        tintClr: new Color(1, 1, 1),
                        temperature: 0,
                        saturation: 1,
                        brightness: 0,
                        blackPoint: 0,
                        whitePoint: 1,
                        transparency: 1
                    },
                    oldState: {
                        tintClr: selected.tintClr.clone(),
                        temperature: selected.temperature,
                        saturation: selected.saturation,
                        brightness: selected.brightness,
                        blackPoint: selected.blackPoint,
                        whitePoint: selected.whitePoint,
                        transparency: selected.transparency
                    }
                });

                events.fire('edit.add', op);
            }
        });

        events.on('selection.changed', (element: Element) => {
            if (element instanceof Splat) {
                selected = element;
                updateUIFromState(selected);
            } else {
                selected = null;
                updateUIFromState(null);
            }
        });

        events.on('selection.shapeChanged', (element: Element) => {
            if (element instanceof SphereShape || element instanceof BoxShape || element instanceof BlockingPlane) {
                selectedShape = element as SphereShape | BoxShape | BlockingPlane;
                updateShapeUIFromState(selectedShape);
            } else {
                selectedShape = null;
                updateShapeUIFromState(null);
            }
        });

        events.on('splat.tintClr', updateUIFromState);
        events.on('splat.temperature', updateUIFromState);
        events.on('splat.saturation', updateUIFromState);
        events.on('splat.brightness', updateUIFromState);
        events.on('splat.blackPoint', updateUIFromState);
        events.on('splat.whitePoint', updateUIFromState);
        events.on('splat.transparency', updateUIFromState);

        tooltips.register(reset, localize('panel.colors.reset'), 'bottom');

        // handle panel visibility (skip in embedded mode, managed by scene-panel)

        if (!embedded) {
            const setVisible = (visible: boolean) => {
                if (visible === this.hidden) {
                    this.hidden = !visible;
                    events.fire('colorPanel.visible', visible);
                }
            };

            events.function('colorPanel.visible', () => {
                return !this.hidden;
            });

            events.on('colorPanel.setVisible', (visible: boolean) => {
                setVisible(visible);
            });

            events.on('colorPanel.toggleVisible', () => {
                setVisible(this.hidden);
            });

            events.on('viewPanel.visible', (visible: boolean) => {
                if (visible) {
                    setVisible(false);
                }
            });
        }
    }
}

export { ColorPanel };
