import { Button, Container, Label, NumericInput } from '@playcanvas/pcui';
import { Asset, Color, GSplatResource, Mat4, Quat, Vec3 } from 'playcanvas';

import { invSigmoid } from '../color-grade';
import { shrinkwrapImageGSplatData } from '../decal-shrinkwrap';
import { AddSplatOp, BitOp, DecalSubdividePaintOp, EditOp, MultiOp, PaintEraseOp, PaintStrokeOp, StateOp } from '../edit-ops';
import { Events } from '../events';
import { downsampleDimensions, imagePixelsToGSplatData } from '../image-import';
import { IndexRanges, sortedPredicate } from '../index-ranges';
import { PaintParameterAdjustmentAxis, paintParameterAdjustment } from '../paint-parameter-adjustment';
import { calculateDecalCoverageStrength, visitDistinctPaintPickIds } from '../paint-pick';
import { Scene } from '../scene';
import { shrinkwrapSplatOpacity } from '../shrinkwrap-opacity';
import { Splat } from '../splat';
import { PaintSettings, SplatPaintRuntime } from '../splat-paint';
import { State } from '../splat-state';
import {
    DecalSubdivisionResult,
    applySubdivisionGroups,
    buildSubdivisionGroupChanges,
    planDecalSubdivision,
    subdivideSplatData
} from '../splat-subdivide';
import { localize } from '../ui/localization';

type NormalizedPoint = { x: number, y: number };
type ScreenPoint = { clientX: number, clientY: number };
type BrushPaintToolName = 'brush' | 'eraser';
type PaintToolName = BrushPaintToolName | 'eyedropper' | 'decal';
type DecalMode = 'subdivide' | 'shrinkwrap';
type BrushStrokeSettings = Omit<PaintSettings, 'radius'> & { radiusPixels: number };

// Ignore fragments that contribute less than 20% opacity while painting. This lets
// brush/decal interaction pass through sparse, nearly transparent stray gaussians.
const paintPickAlphaThreshold = 0.2;
// Keep effectively visible fragments in a second ID layer so the low-alpha
// gaussians that painting passes through still receive the same color.
const paintThroughAlphaThreshold = 1 / 255;
const decalCoverageCutoff = 0.02;
const decalCoveragePaddingPixels = 8;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isBrushPaintTool = (tool: PaintToolName): tool is BrushPaintToolName => tool === 'brush' || tool === 'eraser';

const colorFromHex = (value: string, result = new Color()) => {
    const hex = value.startsWith('#') ? value.substring(1) : value;
    const rgb = Number.parseInt(hex, 16);
    return result.set(((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255, 1);
};

const colorToHex = (color: Color) => {
    const channel = (value: number) => Math.round(clamp(value, 0, 1) * 255).toString(16).padStart(2, '0');
    return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
};

// Render targets use RGBA16F, while the paint color state uses normalized floats.
const halfToFloat = (value: number) => {
    const sign = (value & 0x8000) << 16;
    const exponent = (value & 0x7C00) >> 10;
    const mantissa = value & 0x03FF;
    const float32 = new Float32Array(1);
    const uint32 = new Uint32Array(float32.buffer);

    if (exponent === 0) {
        if (mantissa === 0) {
            uint32[0] = sign;
        } else {
            let exponentShift = -1;
            let normalizedMantissa = mantissa;
            do {
                exponentShift++;
                normalizedMantissa <<= 1;
            } while ((normalizedMantissa & 0x0400) === 0);
            uint32[0] = sign | ((127 - 15 - exponentShift) << 23) | ((normalizedMantissa & 0x03FF) << 13);
        }
    } else if (exponent === 31) {
        uint32[0] = sign | 0x7F800000 | (mantissa << 13);
    } else {
        uint32[0] = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13);
    }

    return float32[0];
};

class PaintTool {
    activate: () => void;
    deactivate: () => void;

    private runtimes = new Map<Splat, SplatPaintRuntime>();

    constructor(events: Events, scene: Scene, parent: HTMLElement, canvasContainer: Container) {
        let enabled = false;
        let pointerId: number | null = null;
        let strokeActive = false;
        let committing = false;
        let strokeGeneration = 0;
        let strokeTarget: Splat | null = null;
        let strokeRuntime: SplatPaintRuntime | null = null;
        let strokeSettings: BrushStrokeSettings | null = null;
        let strokeTool: BrushPaintToolName | null = null;
        let strokeLayerId: string | null = null;
        let strokeAttachedSplats = new Set<Splat>();
        let strokeEraseRuntimes = new Map<Splat, SplatPaintRuntime>();
        let queuedPoint: NormalizedPoint | null = null;
        let processing = false;
        let processingPromise: Promise<void> = Promise.resolve();
        let parameterAdjustment: {
            pointerId: number,
            kind: 'strength' | 'hardness' | 'radius',
            axis: PaintParameterAdjustmentAxis | null,
            startX: number,
            startY: number,
            startValue: number
        } | null = null;
        let lastModelPoint: Vec3 | null = null;
        let lastModelRadius = 0;
        let lastPaintSplat: Splat | null = null;
        let updatingRadiusInput = false;
        let brushRadiusPixels = 10;
        const radiusDisplayMin = 1;
        const radiusDisplayMax = 100;
        const radiusDisplayStep = 1;
        const parameterAdjustmentPixels = 200;
        const radiusStep = radiusDisplayStep;
        let strength = 0.5;
        let hardness = 1;
        let decalStrength = 1;
        let decalSubdivisionStrength = 1;
        let decalShrinkwrapStrength = 0.5;
        const decalCursorOpacityScale = 0.5;
        let decalFeather = 0;
        let decalSize = 128;
        const decalSizeMin = 8;
        const decalSizeMax = 1024;
        const decalSizeStep = 4;
        let decalSubdivisionLevel = 1;
        const decalSubdivisionLevelMin = 0;
        const decalSubdivisionLevelMax = 3;
        let decalSimplificationLevel = 1;
        const decalSimplificationLevelMin = 0;
        const decalSimplificationLevelMax = 3;
        let decalMode: DecalMode = 'subdivide';
        let decalBrightness = 1;
        let decalMixStrength = 0;
        let activePaintTool: PaintToolName = 'brush';
        let colorSampleToken = 0;
        let colorSamplePointerId: number | null = null;
        let queuedColorSample: ScreenPoint | null = null;
        let colorSamplePromise: Promise<void> | null = null;
        const paintColor = new Color(1, 0, 0, 1);
        let sourceDecalImage: ImageData | null = null;
        let decalImageAspect = 1;
        let decalImageLoadToken = 0;

        const inverseWorld = new Mat4();
        const modelPoint = new Vec3();
        const interpolated = new Vec3();
        const cursorWorld = new Vec3();
        const cursorAxisWorld = new Vec3();
        const cursorScreen = new Vec3();
        const cursorAxisScreen = new Vec3();

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'paint-tool-svg';
        svg.setAttribute('aria-hidden', 'true');
        const cursor = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
        cursor.setAttribute('r', brushRadiusPixels.toString());
        const createAdjustmentGuide = (layer: 'back' | 'front') => {
            const guide = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
            guide.classList.add('paint-brush-adjustment-guide', `paint-brush-adjustment-guide-${layer}`);
            guide.style.display = 'none';
            return guide;
        };
        const outerAdjustmentGuideBack = createAdjustmentGuide('back');
        const outerAdjustmentGuideFront = createAdjustmentGuide('front');
        const innerAdjustmentGuideBack = createAdjustmentGuide('back');
        const innerAdjustmentGuideFront = createAdjustmentGuide('front');
        const adjustmentGuides = [
            outerAdjustmentGuideBack,
            outerAdjustmentGuideFront,
            innerAdjustmentGuideBack,
            innerAdjustmentGuideFront
        ];
        const defs = document.createElementNS(svg.namespaceURI, 'defs');
        const gradient = document.createElementNS(svg.namespaceURI, 'radialGradient');
        const gradientId = 'paint-brush-gradient';
        gradient.id = gradientId;
        const gradientCenter = document.createElementNS(svg.namespaceURI, 'stop');
        const gradientHardness = document.createElementNS(svg.namespaceURI, 'stop');
        const gradientEdge = document.createElementNS(svg.namespaceURI, 'stop');
        gradient.appendChild(gradientCenter);
        gradient.appendChild(gradientHardness);
        gradient.appendChild(gradientEdge);
        defs.appendChild(gradient);
        svg.appendChild(defs);
        svg.appendChild(cursor);
        adjustmentGuides.forEach(guide => svg.appendChild(guide));
        parent.appendChild(svg);

        const processedDecalCanvas = document.createElement('canvas');
        const decalCursor = document.createElement('canvas');
        decalCursor.className = 'paint-decal-cursor hidden';
        decalCursor.setAttribute('aria-hidden', 'true');
        parent.appendChild(decalCursor);

        const toolbar = new Container({
            class: ['select-toolbar', 'select-toolbar-tool', 'paint-toolbar'],
            hidden: true
        });
        toolbar.dom.addEventListener('pointerdown', event => event.stopPropagation());
        toolbar.dom.addEventListener('pointerup', event => event.stopPropagation());
        toolbar.dom.addEventListener('wheel', event => event.stopPropagation());

        const colorLabel = new Label({ text: localize('paint.color') });
        const colorDisplay = document.createElement('div');
        colorDisplay.className = 'paint-color-display';
        colorDisplay.setAttribute('aria-hidden', 'true');

        const updateCursorGradient = () => {
            const hardnessPercent = clamp(hardness, 0, 1) * 100;
            const strengthOpacity = clamp(strength, 0, 1) * 0.28;
            const color = isBrushPaintTool(activePaintTool) && parameterAdjustment ? '#ff0000' :
                activePaintTool === 'eraser' ? '#ffffff' : colorToHex(paintColor);
            gradientCenter.setAttribute('offset', '0%');
            gradientCenter.setAttribute('stop-color', color);
            gradientCenter.setAttribute('stop-opacity', strengthOpacity.toString());
            gradientHardness.setAttribute('offset', `${Math.min(hardnessPercent, 99.999)}%`);
            gradientHardness.setAttribute('stop-color', color);
            gradientHardness.setAttribute('stop-opacity', strengthOpacity.toString());
            gradientEdge.setAttribute('offset', '100%');
            gradientEdge.setAttribute('stop-color', color);
            gradientEdge.setAttribute('stop-opacity', '0');
            cursor.style.fill = `url(#${gradientId})`;
            cursor.style.stroke = activePaintTool === 'eraser' ? '#555555' : 'none';
            cursor.style.strokeWidth = activePaintTool === 'eraser' ? '1px' : '0';
        };

        const setAdjustmentGuide = (
            back: SVGCircleElement,
            front: SVGCircleElement,
            radius: number,
            visible: boolean
        ) => {
            const display = visible ? '' : 'none';
            back.style.display = display;
            front.style.display = display;
            if (!visible) return;
            const value = Math.max(radius, 0).toString();
            back.setAttribute('r', value);
            front.setAttribute('r', value);
        };

        const updateAdjustmentCursor = () => {
            const kind = isBrushPaintTool(activePaintTool) ? parameterAdjustment?.kind : undefined;
            const showOuter = kind === 'radius' || kind === 'hardness';
            const showInner = kind === 'hardness';
            setAdjustmentGuide(
                outerAdjustmentGuideBack,
                outerAdjustmentGuideFront,
                brushRadiusPixels,
                showOuter
            );
            setAdjustmentGuide(
                innerAdjustmentGuideBack,
                innerAdjustmentGuideFront,
                brushRadiusPixels * clamp(hardness, 0, 1),
                showInner
            );
            updateCursorGradient();
        };

        const setPaintColor = (value: Color | number[] | string, notify = true) => {
            let next: Color;
            if (typeof value === 'string') {
                next = colorFromHex(value);
            } else if (Array.isArray(value)) {
                next = new Color(value[0] ?? 1, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1);
            } else {
                next = value;
            }
            paintColor.set(next.r, next.g, next.b, next.a);
            colorDisplay.style.backgroundColor = colorToHex(paintColor);
            updateCursorGradient();
            if (notify) events.fire('paint.color.changed', paintColor.clone());
        };

        const sampleScreenColor = async (point: ScreenPoint) => {
            const renderTarget = scene.camera.mainTarget;
            const rect = scene.canvas.getBoundingClientRect();
            if (!renderTarget || !rect.width || !rect.height || !renderTarget.width || !renderTarget.height) return;

            const x = clamp(Math.floor((point.clientX - rect.left) / rect.width * renderTarget.width), 0, renderTarget.width - 1);
            const yFromTop = clamp(Math.floor((point.clientY - rect.top) / rect.height * renderTarget.height), 0, renderTarget.height - 1);
            const y = renderTarget.height - 1 - yFromTop;
            const token = ++colorSampleToken;

            try {
                const pixels = await renderTarget.colorBuffer.read(x, y, 1, 1, {
                    renderTarget,
                    immediate: true
                }) as Uint16Array;
                if (!enabled || token !== colorSampleToken) return;

                const channel = (value: number) => {
                    const decoded = halfToFloat(value);
                    return Number.isFinite(decoded) ? clamp(decoded, 0, 1) : 0;
                };
                setPaintColor([channel(pixels[0]), channel(pixels[1]), channel(pixels[2]), 1]);
            } catch (error) {
                console.error('[Paint] Failed to sample screen color', error);
            }
        };

        const enqueueScreenColorSample = (point: ScreenPoint) => {
            queuedColorSample = point;
            if (colorSamplePromise) return;

            const drainSamples = async () => {
                while (queuedColorSample) {
                    const nextPoint = queuedColorSample;
                    queuedColorSample = null;
                    await sampleScreenColor(nextPoint);
                }
            };

            colorSamplePromise = drainSamples();
            colorSamplePromise.then(() => {
                colorSamplePromise = null;
                if (queuedColorSample) enqueueScreenColorSample(queuedColorSample);
            });
        };

        const releaseColorSamplePointer = () => {
            if (colorSamplePointerId === null) return;
            if (parent.hasPointerCapture(colorSamplePointerId)) parent.releasePointerCapture(colorSamplePointerId);
            colorSamplePointerId = null;
        };

        const strengthLabel = new Label({ text: localize('paint.strength') });
        const strengthInput = new NumericInput({
            class: 'select-toolbar-input',
            value: strength,
            min: 0,
            max: 1,
            precision: 2,
            step: 0.05,
            width: 52
        });

        const hardnessLabel = new Label({ text: localize('paint.hardness') });
        const hardnessInput = new NumericInput({
            class: 'select-toolbar-input',
            value: hardness,
            min: 0,
            max: 1,
            precision: 2,
            step: 0.05,
            width: 52
        });

        const radiusLabel = new Label({ text: localize('paint.radius') });
        const radiusInput = new NumericInput({
            class: 'select-toolbar-input',
            value: brushRadiusPixels,
            min: radiusDisplayMin,
            max: radiusDisplayMax,
            precision: 0,
            step: radiusDisplayStep,
            width: 52
        });

        const decalImportButton = new Button({
            class: ['select-toolbar-button', 'paint-decal-import-button'],
            text: localize('paint.decal.import')
        });
        const decalFileInput = document.createElement('input');
        decalFileInput.type = 'file';
        decalFileInput.accept = 'image/png,image/jpeg,.png,.jpg,.jpeg';
        decalFileInput.className = 'paint-decal-file-input';

        const decalToolbarPreview = document.createElement('canvas');
        decalToolbarPreview.className = 'paint-decal-toolbar-preview';
        decalToolbarPreview.width = 76;
        decalToolbarPreview.height = 60;
        decalToolbarPreview.setAttribute('aria-label', localize('paint.decal.preview'));

        const decalStrengthLabel = new Label({ text: localize('paint.strength') });
        const decalStrengthInput = new NumericInput({
            class: 'select-toolbar-input',
            value: decalStrength,
            min: 0,
            max: 1,
            precision: 2,
            step: 0.05,
            width: 52
        });

        const decalFeatherLabel = new Label({ text: localize('paint.feather') });
        const decalFeatherInput = new NumericInput({
            class: 'select-toolbar-input',
            value: decalFeather,
            min: 0,
            max: 1,
            precision: 2,
            step: 0.05,
            width: 52
        });

        const decalSizeLabel = new Label({ text: localize('paint.decal.size') });
        const decalSizeInput = new NumericInput({
            class: 'select-toolbar-input',
            value: decalSize,
            min: decalSizeMin,
            max: decalSizeMax,
            precision: 0,
            step: decalSizeStep,
            width: 52
        });

        const decalSubdivisionLabel = new Label({ text: localize('paint.decal.subdivision-level') });
        const decalSubdivisionInput = new NumericInput({
            class: 'select-toolbar-input',
            value: decalSubdivisionLevel,
            min: decalSubdivisionLevelMin,
            max: decalSubdivisionLevelMax,
            precision: 0,
            step: 1,
            width: 52
        });

        toolbar.append(colorLabel);
        toolbar.dom.appendChild(colorDisplay);
        toolbar.append(strengthLabel);
        toolbar.append(strengthInput);
        toolbar.append(hardnessLabel);
        toolbar.append(hardnessInput);
        toolbar.append(radiusLabel);
        toolbar.append(radiusInput);
        toolbar.append(decalImportButton);
        toolbar.dom.appendChild(decalFileInput);
        toolbar.dom.appendChild(decalToolbarPreview);
        toolbar.append(decalStrengthLabel);
        toolbar.append(decalStrengthInput);
        toolbar.append(decalFeatherLabel);
        toolbar.append(decalFeatherInput);
        toolbar.append(decalSizeLabel);
        toolbar.append(decalSizeInput);
        toolbar.append(decalSubdivisionLabel);
        toolbar.append(decalSubdivisionInput);
        canvasContainer.append(toolbar);

        const updateDecalCursorSize = () => {
            const aspect = Math.max(decalImageAspect, 1e-6);
            const width = aspect >= 1 ? decalSize : decalSize * aspect;
            const height = aspect >= 1 ? decalSize / aspect : decalSize;
            decalCursor.style.width = `${width}px`;
            decalCursor.style.height = `${height}px`;
        };

        const updateDecalPreviews = () => {
            const cursorContext = decalCursor.getContext('2d');
            if (cursorContext && processedDecalCanvas.width && processedDecalCanvas.height) {
                decalCursor.width = processedDecalCanvas.width;
                decalCursor.height = processedDecalCanvas.height;
                cursorContext.clearRect(0, 0, decalCursor.width, decalCursor.height);
                cursorContext.drawImage(processedDecalCanvas, 0, 0);
            }

            const toolbarContext = decalToolbarPreview.getContext('2d');
            if (toolbarContext) {
                toolbarContext.clearRect(0, 0, decalToolbarPreview.width, decalToolbarPreview.height);
                if (processedDecalCanvas.width && processedDecalCanvas.height) {
                    const scale = Math.min(
                        decalToolbarPreview.width / processedDecalCanvas.width,
                        decalToolbarPreview.height / processedDecalCanvas.height
                    );
                    const width = processedDecalCanvas.width * scale;
                    const height = processedDecalCanvas.height * scale;
                    toolbarContext.drawImage(
                        processedDecalCanvas,
                        (decalToolbarPreview.width - width) * 0.5,
                        (decalToolbarPreview.height - height) * 0.5,
                        width,
                        height
                    );
                }
            }
            updateDecalCursorSize();
        };

        const processDecalImage = () => {
            if (!sourceDecalImage) return;
            const source = sourceDecalImage.data;
            const output = new Uint8ClampedArray(source.length);
            const brightness = clamp(decalBrightness, 0, 1);
            const mixStrength = clamp(decalMixStrength, 0, 1);
            const tint = [paintColor.r, paintColor.g, paintColor.b];

            for (let i = 0; i < source.length; i += 4) {
                for (let channel = 0; channel < 3; ++channel) {
                    const original = source[i + channel] / 255 * brightness;
                    const lightened = Math.max(original, tint[channel]);
                    output[i + channel] = Math.round((original + (lightened - original) * mixStrength) * 255);
                }
                output[i + 3] = source[i + 3];
            }

            processedDecalCanvas.width = sourceDecalImage.width;
            processedDecalCanvas.height = sourceDecalImage.height;
            processedDecalCanvas.getContext('2d')?.putImageData(
                new ImageData(output, sourceDecalImage.width, sourceDecalImage.height),
                0,
                0
            );
            updateDecalPreviews();
        };

        const loadDecalImage = async (url: string, revokeUrl = false) => {
            const loadToken = ++decalImageLoadToken;
            const image = new Image();
            try {
                await new Promise<void>((resolve, reject) => {
                    image.onload = () => resolve();
                    image.onerror = () => reject(new Error('Unable to decode decal image.'));
                    image.src = url;
                });

                const sourceCanvas = document.createElement('canvas');
                const maxDimension = 1024;
                const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
                sourceCanvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                sourceCanvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                const context = sourceCanvas.getContext('2d');
                if (!context) throw new Error('Unable to create decal image context.');
                context.drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height);
                if (loadToken !== decalImageLoadToken) return;
                sourceDecalImage = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
                decalImageAspect = sourceCanvas.width / sourceCanvas.height;
                processDecalImage();
            } catch (error) {
                console.error('[Paint] Failed to load decal image', error);
            } finally {
                if (revokeUrl) URL.revokeObjectURL(url);
            }
        };

        decalImportButton.on('click', () => decalFileInput.click());
        decalFileInput.addEventListener('change', () => {
            const file = decalFileInput.files?.[0];
            decalFileInput.value = '';
            if (!file) return;
            loadDecalImage(URL.createObjectURL(file), true);
        });
        loadDecalImage('./static/icons/Logo512x512.png');

        const syncDecalDensityControl = () => {
            const shrinkwrap = decalMode === 'shrinkwrap';
            decalSubdivisionLabel.text = localize(shrinkwrap ?
                'paint.decal.simplification-level' :
                'paint.decal.subdivision-level');
            decalSubdivisionInput.min = shrinkwrap ? decalSimplificationLevelMin : decalSubdivisionLevelMin;
            decalSubdivisionInput.max = shrinkwrap ? decalSimplificationLevelMax : decalSubdivisionLevelMax;
            decalSubdivisionInput.value = shrinkwrap ? decalSimplificationLevel : decalSubdivisionLevel;
        };

        const setDecalStrength = (value: number) => {
            decalStrength = clamp(value, 0, 1);
            if (decalMode === 'shrinkwrap') {
                decalShrinkwrapStrength = decalStrength;
            } else {
                decalSubdivisionStrength = decalStrength;
            }
            decalStrengthInput.value = decalStrength;
            decalCursor.style.opacity = (decalStrength * decalCursorOpacityScale).toString();
        };

        const syncDecalStrengthControl = () => {
            decalStrength = decalMode === 'shrinkwrap' ? decalShrinkwrapStrength : decalSubdivisionStrength;
            decalStrengthInput.value = decalStrength;
            decalCursor.style.opacity = (decalStrength * decalCursorOpacityScale).toString();
        };

        const updatePaintToolbar = (toolName: PaintToolName) => {
            const eyedropper = toolName === 'eyedropper';
            const brush = toolName === 'brush';
            const eraser = toolName === 'eraser';
            const brushTool = brush || eraser;
            const decal = toolName === 'decal';
            syncDecalDensityControl();
            syncDecalStrengthControl();
            colorLabel.hidden = decal || eraser;
            colorDisplay.hidden = decal || eraser;
            strengthLabel.hidden = !brushTool;
            strengthInput.hidden = !brushTool;
            hardnessLabel.hidden = !brushTool;
            hardnessInput.hidden = !brushTool;
            radiusLabel.hidden = !brushTool;
            radiusInput.hidden = !brushTool;
            decalImportButton.hidden = !decal;
            decalToolbarPreview.hidden = !decal;
            decalStrengthLabel.hidden = !decal;
            decalStrengthInput.hidden = !decal;
            decalFeatherLabel.hidden = !decal;
            decalFeatherInput.hidden = !decal;
            decalSizeLabel.hidden = !decal;
            decalSizeInput.hidden = !decal;
            decalSubdivisionLabel.hidden = !decal;
            decalSubdivisionInput.hidden = !decal;
            cursor.style.display = brushTool ? '' : 'none';
            decalCursor.classList.add('hidden');
        };
        updatePaintToolbar(activePaintTool);

        const isMultiLod = (splat: Splat) => !!splat.lodEditLog && splat.lodCounts.length > 1;
        const getTarget = () => {
            const splat = events.functions.has('paint.target') ?
                events.invoke('paint.target') as Splat | null :
                events.invoke('splatSelection') as Splat | null;
            return splat?.scene === scene && splat.visible && !isMultiLod(splat) ? splat : null;
        };

        const syncBrushRadiusUi = () => {
            radiusInput.min = radiusDisplayMin;
            radiusInput.max = radiusDisplayMax;
            radiusInput.step = radiusDisplayStep;
            updatingRadiusInput = true;
            radiusInput.value = brushRadiusPixels;
            updatingRadiusInput = false;
            cursor.setAttribute('r', brushRadiusPixels.toString());
        };

        const getRuntime = (splat: Splat, previewEnabled = true) => {
            let runtime = this.runtimes.get(splat);
            if (!runtime) {
                runtime = new SplatPaintRuntime(splat);
                this.runtimes.set(splat, runtime);
            }
            runtime.setPreviewEnabled(previewEnabled);
            return runtime;
        };

        const destroyRuntime = (splat: Splat) => {
            const runtime = this.runtimes.get(splat);
            if (!runtime) return;
            runtime.destroy();
            this.runtimes.delete(splat);
        };

        const destroyRuntimes = () => {
            this.runtimes.forEach(runtime => runtime.destroy());
            this.runtimes.clear();
        };

        const getPoint = (event: PointerEvent): NormalizedPoint => {
            const rect = parent.getBoundingClientRect();
            return {
                x: clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1),
                y: clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1)
            };
        };

        const updateCursorPosition = (event: PointerEvent) => {
            const rect = parent.getBoundingClientRect();
            const x = (event.clientX - rect.left) * parent.offsetWidth / Math.max(rect.width, 1);
            const y = (event.clientY - rect.top) * parent.offsetHeight / Math.max(rect.height, 1);
            cursor.setAttribute('cx', x.toString());
            cursor.setAttribute('cy', y.toString());
            adjustmentGuides.forEach((guide) => {
                guide.setAttribute('cx', x.toString());
                guide.setAttribute('cy', y.toString());
            });
            decalCursor.style.left = `${x}px`;
            decalCursor.style.top = `${y}px`;
            if (activePaintTool === 'decal') decalCursor.classList.remove('hidden');
        };

        // Convert the fixed screen-space brush radius into the model-space
        // sphere radius required by the GPU paint processor. The largest
        // singular value of the local-to-screen derivative keeps the brush
        // bounded by the circular cursor even with a scaled/rotated model.
        const modelRadiusForScreenRadius = (splat: Splat, center: Vec3, screenRadius: number) => {
            const width = parent.offsetWidth || 1;
            const height = parent.offsetHeight || 1;
            splat.worldTransform.transformPoint(center, cursorWorld);
            scene.camera.worldToScreen(cursorWorld, cursorScreen);

            const probeRadius = Math.max(splat.localBound.halfExtents.length() * 0.0002, 1e-6);
            const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            let xx = 0;
            let xy = 0;
            let yy = 0;
            for (const axis of axes) {
                cursorAxisWorld.set(
                    center.x + axis[0] * probeRadius,
                    center.y + axis[1] * probeRadius,
                    center.z + axis[2] * probeRadius
                );
                splat.worldTransform.transformPoint(cursorAxisWorld, cursorAxisWorld);
                scene.camera.worldToScreen(cursorAxisWorld, cursorAxisScreen);
                const dx = (cursorAxisScreen.x - cursorScreen.x) * width / probeRadius;
                const dy = (cursorAxisScreen.y - cursorScreen.y) * height / probeRadius;
                xx += dx * dx;
                xy += dx * dy;
                yy += dy * dy;
            }

            const discriminant = Math.sqrt(Math.max(0, (xx - yy) * (xx - yy) + 4 * xy * xy));
            const pixelsPerModelUnit = Math.sqrt(Math.max(0, (xx + yy + discriminant) * 0.5));
            return Number.isFinite(pixelsPerModelUnit) && pixelsPerModelUnit > 1e-8 ?
                Math.max(screenRadius / pixelsPerModelUnit, 1e-8) : 1e-8;
        };

        const setRadiusDisplayValue = (displayValue: number) => {
            brushRadiusPixels = clamp(displayValue, radiusDisplayMin, radiusDisplayMax);
            syncBrushRadiusUi();
        };

        const processPoint = async (point: NormalizedPoint, generation: number) => {
            const eraseCandidates = strokeTool === 'eraser' && strokeTarget ?
                [strokeTarget, ...strokeAttachedSplats] : undefined;
            const hit = await scene.camera.intersect(
                point.x,
                point.y,
                eraseCandidates ? paintThroughAlphaThreshold : paintPickAlphaThreshold,
                eraseCandidates
            );
            if (generation !== strokeGeneration || !strokeActive || !strokeTarget || !strokeRuntime || !strokeSettings || !strokeTool ||
                getTarget() !== strokeTarget) return;
            const target = strokeTarget;
            const paintSplat = hit?.splat;
            const attachedEraseTarget = strokeTool === 'eraser' && paintSplat && strokeAttachedSplats.has(paintSplat);
            if (!paintSplat || (paintSplat !== target && !attachedEraseTarget)) {
                lastModelPoint = null;
                lastModelRadius = 0;
                lastPaintSplat = null;
                return;
            }

            let runtime = paintSplat === target ? strokeRuntime : strokeEraseRuntimes.get(paintSplat);
            if (!runtime) {
                runtime = getRuntime(paintSplat, false);
                strokeEraseRuntimes.set(paintSplat, runtime);
            }
            const settings = strokeSettings;
            scene.camera.pickPrep(paintSplat, 'set', paintThroughAlphaThreshold);
            const paintThroughId = await scene.camera.pick(point.x, point.y);
            const runtimeStillActive = paintSplat === target ? strokeRuntime === runtime :
                strokeEraseRuntimes.get(paintSplat) === runtime;
            if (generation !== strokeGeneration || !strokeActive || strokeTarget !== target || !runtimeStillActive ||
                strokeSettings !== settings || getTarget() !== target) return;

            if (lastPaintSplat !== paintSplat) {
                lastModelPoint = null;
                lastModelRadius = 0;
            }
            inverseWorld.copy(paintSplat.worldTransform).invert();
            inverseWorld.transformPoint(hit.position, modelPoint);
            const modelRadius = modelRadiusForScreenRadius(paintSplat, modelPoint, settings.radiusPixels);
            const paintSettings: PaintSettings = {
                color: settings.color,
                strength: settings.strength,
                hardness: settings.hardness,
                radius: modelRadius
            };

            if (lastModelPoint) {
                const distance = lastModelPoint.distance(modelPoint);
                const spacingRadius = Math.min(lastModelRadius || modelRadius, modelRadius);
                const steps = Math.max(1, Math.ceil(distance / Math.max(spacingRadius * 0.5, 1e-8)));
                for (let i = 1; i <= steps; ++i) {
                    const t = i / steps;
                    interpolated.lerp(lastModelPoint, modelPoint, t);
                    paintSettings.radius = lastModelRadius + (modelRadius - lastModelRadius) * t;
                    runtime.paintSphere(interpolated, paintSettings);
                }
            } else {
                runtime.paintSphere(modelPoint, paintSettings);
            }
            runtime.queuePaintSample(paintThroughId, settings.color, settings.strength);

            if (!lastModelPoint) lastModelPoint = new Vec3();
            lastModelPoint.copy(modelPoint);
            lastModelRadius = modelRadius;
            lastPaintSplat = paintSplat;
        };

        const pumpQueue = async (generation: number) => {
            processing = true;
            try {
                for (;;) {
                    if (!queuedPoint || generation !== strokeGeneration || !strokeActive) break;
                    const point = queuedPoint;
                    queuedPoint = null;
                    await processPoint(point, generation);
                }
            } finally {
                processing = false;
            }
        };

        const enqueuePoint = (point: NormalizedPoint) => {
            queuedPoint = point;
            if (!processing) {
                processingPromise = pumpQueue(strokeGeneration);
            }
        };

        const waitForSamples = async () => {
            for (;;) {
                if (!processing && !queuedPoint) break;
                if (!processing && queuedPoint) {
                    processingPromise = pumpQueue(strokeGeneration);
                }
                await processingPromise;
            }
        };

        const releasePointer = () => {
            if (pointerId === null) return;
            if (parent.hasPointerCapture(pointerId)) parent.releasePointerCapture(pointerId);
            pointerId = null;
        };

        const cancelStroke = () => {
            strokeGeneration++;
            queuedPoint = null;
            strokeActive = false;
            lastModelPoint = null;
            lastModelRadius = 0;
            lastPaintSplat = null;
            releasePointer();
            strokeRuntime?.clear();
            strokeEraseRuntimes.forEach(runtime => runtime.clear());
            strokeTarget = null;
            strokeRuntime = null;
            strokeSettings = null;
            strokeTool = null;
            strokeLayerId = null;
            strokeAttachedSplats.clear();
            strokeEraseRuntimes.clear();
        };

        const wrapPaintOperation = (op: EditOp, layerId?: string | null) => {
            if (!events.functions.has('paint.layers.wrapOperation')) return op;
            return events.invoke('paint.layers.wrapOperation', op, layerId ?? undefined) as EditOp;
        };

        const setBusy = (value: boolean) => {
            committing = value;
            strengthInput.enabled = !value;
            hardnessInput.enabled = !value;
            radiusInput.enabled = !value;
            decalImportButton.enabled = !value;
            decalStrengthInput.enabled = !value;
            decalFeatherInput.enabled = !value;
            decalSizeInput.enabled = !value;
            decalSubdivisionInput.enabled = !value;
            events.fire('paint.busy', value);
        };

        const stampDecal = async (point: NormalizedPoint) => {
            const target = getTarget();
            const renderTarget = scene.camera.mainTarget;
            if (!target || !renderTarget || !sourceDecalImage || !processedDecalCanvas.width || !processedDecalCanvas.height) return;
            const stampMode = decalMode;
            const stampLayerId = events.functions.has('paint.layers.active') ? events.invoke('paint.layers.active') as string : null;

            const subdivisionUnavailable = !!(
                target.lodEditLog || target.lccFilePath || target.pagedLodEditSession || target.pagedLodDescriptor
            );
            if (stampMode === 'subdivide' && decalSubdivisionLevel > 0 && subdivisionUnavailable) {
                await events.invoke('showPopup', {
                    type: 'info',
                    header: localize('paint.decal.subdivision-unavailable-header'),
                    message: localize('paint.decal.subdivision-unavailable-message')
                });
                return;
            }

            const parentWidth = Math.max(parent.offsetWidth, 1);
            const parentHeight = Math.max(parent.offsetHeight, 1);
            const aspect = Math.max(decalImageAspect, 1e-6);
            const cssWidth = aspect >= 1 ? decalSize : decalSize * aspect;
            const cssHeight = aspect >= 1 ? decalSize / aspect : decalSize;
            const normalizedWidth = cssWidth / parentWidth;
            const normalizedHeight = cssHeight / parentHeight;
            const fullLeft = point.x - normalizedWidth * 0.5;
            const fullTop = point.y - normalizedHeight * 0.5;
            const left = clamp(fullLeft, 0, 1);
            const top = clamp(fullTop, 0, 1);
            const right = clamp(fullLeft + normalizedWidth, 0, 1);
            const bottom = clamp(fullTop + normalizedHeight, 0, 1);
            if (right <= left || bottom <= top) return;
            // Include transparent pixels just outside the image rectangle when
            // estimating a gaussian's full screen footprint. Without this
            // margin, points crossing the decal bounds would have an inflated
            // coverage ratio because their outside portion was never counted.
            const sampleLeft = clamp(left - decalCoveragePaddingPixels / parentWidth, 0, 1);
            const sampleTop = clamp(top - decalCoveragePaddingPixels / parentHeight, 0, 1);
            const sampleRight = clamp(right + decalCoveragePaddingPixels / parentWidth, 0, 1);
            const sampleBottom = clamp(bottom + decalCoveragePaddingPixels / parentHeight, 0, 1);

            setBusy(true);
            let runtime: SplatPaintRuntime | null = null;
            let subdivision: DecalSubdivisionResult | null = null;
            let uncommittedWrappedSplat: Splat | null = null;
            let groupChanges: ReturnType<typeof buildSubdivisionGroupChanges> = [];
            let originalSnapshot: {
                data: Splat['splatData'],
                transformIndices: Uint16Array,
                soloMask: Uint8Array,
                desaturateMask: Uint8Array
            } | null = null;

            try {
                const targetStillActive = () => enabled && activePaintTool === 'decal' && decalMode === stampMode &&
                    getTarget() === target &&
                    (!stampLayerId || events.invoke('paint.layers.active') === stampLayerId) &&
                    (!events.functions.has('paint.layers.activeVisible') || events.invoke('paint.layers.activeVisible'));
                const readPickLayers = async () => {
                    scene.camera.pickPrep(target, 'set', paintPickAlphaThreshold);
                    const visibleIds = await scene.camera.pickRect(
                        sampleLeft,
                        sampleTop,
                        sampleRight - sampleLeft,
                        sampleBottom - sampleTop
                    );
                    if (!targetStillActive()) return null;
                    // Shrinkwrap only needs the trusted front surface. The
                    // low-alpha paint-through layer below exists solely so the
                    // subdivision decal can dye the source Gaussians.
                    if (stampMode === 'shrinkwrap') return [visibleIds];

                    scene.camera.pickPrep(target, 'set', paintThroughAlphaThreshold);
                    const paintThroughIds = await scene.camera.pickRect(
                        sampleLeft,
                        sampleTop,
                        sampleRight - sampleLeft,
                        sampleBottom - sampleTop
                    );
                    return targetStillActive() ? [visibleIds, paintThroughIds] : null;
                };

                const targetWidth = renderTarget.width;
                const targetHeight = renderTarget.height;
                const pixelLeft = Math.floor(sampleLeft * targetWidth);
                const pixelTop = Math.floor(sampleTop * targetHeight);
                const pixelWidth = Math.max(1, Math.ceil(sampleRight * targetWidth) - pixelLeft);
                const pixelHeight = Math.max(1, Math.ceil(sampleBottom * targetHeight) - pixelTop);
                const pixelCount = pixelWidth * pixelHeight;
                let pickedIdLayers = await readPickLayers();
                if (!pickedIdLayers || pickedIdLayers.some(ids => ids.length < pixelCount)) return;

                if (stampMode === 'shrinkwrap') {
                    const targetSize = downsampleDimensions(
                        processedDecalCanvas.width,
                        processedDecalCanvas.height,
                        decalSimplificationLevel
                    );
                    const wrapCanvas = document.createElement('canvas');
                    wrapCanvas.width = targetSize.width;
                    wrapCanvas.height = targetSize.height;
                    const wrapContext = wrapCanvas.getContext('2d', { willReadFrequently: true });
                    if (!wrapContext) throw new Error('Unable to create shrinkwrap decal context.');
                    wrapContext.imageSmoothingEnabled = true;
                    wrapContext.imageSmoothingQuality = 'high';
                    wrapContext.drawImage(processedDecalCanvas, 0, 0, targetSize.width, targetSize.height);
                    const wrapImage = wrapContext.getImageData(0, 0, targetSize.width, targetSize.height);

                    let visiblePixels = 0;
                    for (let row = 0; row < wrapImage.height; ++row) {
                        for (let column = 0; column < wrapImage.width; ++column) {
                            const u = (column + 0.5) / wrapImage.width;
                            const v = (row + 0.5) / wrapImage.height;
                            const normalizedX = fullLeft + u * normalizedWidth;
                            const normalizedY = fullTop + v * normalizedHeight;
                            const alphaIndex = (row * wrapImage.width + column) * 4 + 3;
                            if (normalizedX < 0 || normalizedX > 1 || normalizedY < 0 || normalizedY > 1) {
                                wrapImage.data[alphaIndex] = 0;
                                continue;
                            }

                            if (wrapImage.data[alphaIndex] > 0) visiblePixels++;
                        }
                    }
                    if (visiblePixels === 0) return;

                    const wrappedData = imagePixelsToGSplatData(wrapImage);
                    const wrappedOpacity = wrappedData.getProp('opacity') as Float32Array;
                    let wrappedIndex = 0;
                    for (let row = 0; row < wrapImage.height; ++row) {
                        for (let column = 0; column < wrapImage.width; ++column) {
                            const alpha = wrapImage.data[(row * wrapImage.width + column) * 4 + 3];
                            if (alpha === 0) continue;
                            const u = (column + 0.5) / wrapImage.width;
                            const v = (row + 0.5) / wrapImage.height;
                            const edgeDistance = clamp(Math.min(u, 1 - u, v, 1 - v) * 2, 0, 1);
                            let featherAlpha = 1;
                            if (decalFeather > 1e-6) {
                                const t = clamp(edgeDistance / decalFeather, 0, 1);
                                featherAlpha = t * t * (3 - 2 * t);
                            }
                            const desiredOpacity = alpha / 255 * clamp(decalStrength, 0, 1) * featherAlpha;
                            wrappedOpacity[wrappedIndex++] = invSigmoid(shrinkwrapSplatOpacity(desiredOpacity));
                        }
                    }
                    if (wrappedIndex !== wrappedData.numSplats) {
                        throw new Error('Shrinkwrap opacity count does not match the generated Gaussians.');
                    }
                    const canvasRect = scene.canvas.getBoundingClientRect();
                    const stats = shrinkwrapImageGSplatData(wrappedData, wrapImage, {
                        camera: scene.camera,
                        canvasWidth: canvasRect.width,
                        canvasHeight: canvasRect.height,
                        fullLeft,
                        fullTop,
                        normalizedWidth,
                        normalizedHeight,
                        targetWidth,
                        targetHeight,
                        pixelLeft,
                        pixelTop,
                        pixelWidth,
                        pixelHeight,
                        pickIds: pickedIdLayers[0],
                        splatCount: target.splatData.numSplats,
                        getWorldPosition: (splatIndex, result) => target.calcSplatWorldPosition(splatIndex, result)
                    });
                    if (!stats || !targetStillActive()) return;

                    const filename = `${localize('paint.decal.shrinkwrap-name')}_${Date.now()}.ply`;
                    const asset = new Asset(filename, 'gsplat', {
                        url: `local-decal-shrinkwrap-${Date.now()}`,
                        filename
                    });
                    scene.app.assets.add(asset);
                    asset.resource = new GSplatResource(scene.app.graphicsDevice, wrappedData);
                    uncommittedWrappedSplat = new Splat(asset, new Quat());
                    await scene.add(uncommittedWrappedSplat);
                    if (events.functions.has('paint.layers.attachSplat')) {
                        events.invoke('paint.layers.attachSplat', uncommittedWrappedSplat, stampLayerId ?? undefined);
                    }
                    // Scene insertion selects the generated decal. Keep the
                    // trusted source selected so repeated clicks keep wrapping
                    // onto the same surface.
                    events.fire('selection', target);
                    events.fire('edit.add', new AddSplatOp(scene, uncommittedWrappedSplat), true);
                    console.info('[Paint] Shrinkwrapped decal', stats);
                    uncommittedWrappedSplat = null; // edit history owns it now
                    // Do not fall through into collectSamples/paintSamples:
                    // shrinkwrap colors only its newly created Gaussians and
                    // must leave every hit source Gaussian unchanged.
                    return;
                }

                const stampCanvas = document.createElement('canvas');
                stampCanvas.width = pixelWidth;
                stampCanvas.height = pixelHeight;
                const stampContext = stampCanvas.getContext('2d');
                if (!stampContext) throw new Error('Unable to create decal stamp context.');
                stampContext.imageSmoothingEnabled = true;
                stampContext.imageSmoothingQuality = 'high';
                stampContext.drawImage(
                    processedDecalCanvas,
                    fullLeft * targetWidth - pixelLeft,
                    fullTop * targetHeight - pixelTop,
                    normalizedWidth * targetWidth,
                    normalizedHeight * targetHeight
                );
                const stampPixels = stampContext.getImageData(0, 0, pixelWidth, pixelHeight).data;

                const collectSamples = (idLayers: ArrayLike<number>[], count: number) => {
                    const sampleById = new Map<number, number>();
                    const projectedAreaById = new Map<number, number>();
                    const touched: number[] = [];
                    const footprintPixels: number[] = [];
                    const coveredAlpha: number[] = [];
                    const red: number[] = [];
                    const green: number[] = [];
                    const blue: number[] = [];

                    visitDistinctPaintPickIds(idLayers, pixelCount, count, (bufferPixel, id) => {
                        const bufferY = Math.floor(bufferPixel / pixelWidth);
                        const x = bufferPixel - bufferY * pixelWidth;
                        const y = pixelHeight - 1 - bufferY;
                        const normalizedY = ((pixelTop + y + 0.5) / targetHeight - fullTop) / normalizedHeight;
                        const pixel = (y * pixelWidth + x) * 4;
                        let sampleIndex = sampleById.get(id);
                        if (sampleIndex === undefined) {
                            sampleIndex = touched.length;
                            sampleById.set(id, sampleIndex);
                            touched.push(id);
                            footprintPixels.push(0);
                            coveredAlpha.push(0);
                            red.push(0);
                            green.push(0);
                            blue.push(0);
                        }
                        footprintPixels[sampleIndex]++;

                        const sourceAlpha = stampPixels[pixel + 3] / 255;
                        if (sourceAlpha <= 0) return;

                        const normalizedX = ((pixelLeft + x + 0.5) / targetWidth - fullLeft) / normalizedWidth;
                        const edgeDistance = clamp(Math.min(
                            normalizedX,
                            1 - normalizedX,
                            normalizedY,
                            1 - normalizedY
                        ) * 2, 0, 1);
                        let featherAlpha = 1;
                        if (decalFeather > 1e-6) {
                            const t = clamp(edgeDistance / decalFeather, 0, 1);
                            featherAlpha = t * t * (3 - 2 * t);
                        }
                        const coverage = sourceAlpha * featherAlpha;
                        if (coverage <= 0) return;

                        coveredAlpha[sampleIndex] += coverage;
                        red[sampleIndex] += stampPixels[pixel] / 255 * coverage;
                        green[sampleIndex] += stampPixels[pixel + 1] / 255 * coverage;
                        blue[sampleIndex] += stampPixels[pixel + 2] / 255 * coverage;
                    });

                    const accepted: number[] = [];
                    for (let i = 0; i < touched.length; ++i) {
                        const sampleStrength = calculateDecalCoverageStrength(
                            coveredAlpha[i],
                            footprintPixels[i],
                            decalStrength,
                            decalCoverageCutoff
                        );
                        if (sampleStrength <= 0) continue;
                        accepted.push(i);
                        projectedAreaById.set(touched[i], footprintPixels[i]);
                    }

                    const indices = new Uint32Array(accepted.length);
                    const colors = new Float32Array(accepted.length * 4);
                    for (let outputIndex = 0; outputIndex < accepted.length; ++outputIndex) {
                        const sampleIndex = accepted[outputIndex];
                        const weight = Math.max(coveredAlpha[sampleIndex], 1e-8);
                        indices[outputIndex] = touched[sampleIndex];
                        colors[outputIndex * 4] = red[sampleIndex] / weight;
                        colors[outputIndex * 4 + 1] = green[sampleIndex] / weight;
                        colors[outputIndex * 4 + 2] = blue[sampleIndex] / weight;
                        colors[outputIndex * 4 + 3] = calculateDecalCoverageStrength(
                            coveredAlpha[sampleIndex],
                            footprintPixels[sampleIndex],
                            decalStrength,
                            decalCoverageCutoff
                        );
                    }
                    return { indices, colors, projectedAreaById };
                };

                let samples = collectSamples(pickedIdLayers, target.splatData.numSplats);
                if (samples.indices.length === 0) return;

                if (decalSubdivisionLevel > 0) {
                    const requests = planDecalSubdivision(samples.projectedAreaById, decalSubdivisionLevel);
                    if (requests.length > 0) {
                        originalSnapshot = {
                            data: target.splatData,
                            transformIndices: target.getTransformIndices(),
                            soloMask: new Uint8Array(target.soloMaskData),
                            desaturateMask: new Uint8Array(target.desaturateMaskData)
                        };
                        subdivision = subdivideSplatData(
                            originalSnapshot.data,
                            requests,
                            originalSnapshot.transformIndices,
                            originalSnapshot.soloMask,
                            originalSnapshot.desaturateMask
                        );
                        if (subdivision) {
                            groupChanges = buildSubdivisionGroupChanges(
                                events,
                                target,
                                originalSnapshot.data.numSplats,
                                subdivision.data.numSplats,
                                subdivision.childRanges
                            );
                            destroyRuntime(target);
                            await target.replaceSplatData(subdivision);
                            applySubdivisionGroups(events, target, groupChanges, true);
                            if (!targetStillActive()) throw new Error('Decal target changed during subdivision.');

                            const repickedIdLayers = await readPickLayers();
                            if (!repickedIdLayers || repickedIdLayers.some(ids => ids.length < pixelCount)) {
                                throw new Error('Unable to repick subdivided decal surface.');
                            }
                            pickedIdLayers = repickedIdLayers;
                            samples = collectSamples(pickedIdLayers, target.splatData.numSplats);
                            if (samples.indices.length === 0) throw new Error('Subdivision produced no visible decal samples.');
                        }
                    }
                }

                runtime = getRuntime(target);
                runtime.clear();
                runtime.paintSamples({ indices: samples.indices, colors: samples.colors });
                const delta = await runtime.commit();
                if (delta && target.scene) {
                    if (subdivision) {
                        events.fire('edit.add', wrapPaintOperation(new DecalSubdividePaintOp({
                            splat: target,
                            events,
                            structuralIndices: subdivision.structuralIndices,
                            beforeStates: subdivision.beforeStates,
                            afterStates: subdivision.afterStates,
                            paintIndices: delta.indices,
                            beforePaint: delta.before,
                            afterPaint: delta.after,
                            paintColors: delta.colors,
                            groupChanges
                        }), stampLayerId), true);
                    } else {
                        events.fire('edit.add', wrapPaintOperation(new PaintStrokeOp({
                            splat: target,
                            indices: delta.indices,
                            before: delta.before,
                            after: delta.after,
                            colors: delta.colors
                        }), stampLayerId), true);
                    }
                } else if (subdivision) {
                    throw new Error('Subdivision produced no decal color changes.');
                }
            } catch (error) {
                runtime?.clear();
                if (uncommittedWrappedSplat) {
                    if (uncommittedWrappedSplat.scene === scene) scene.remove(uncommittedWrappedSplat);
                    uncommittedWrappedSplat.destroy();
                    events.fire('selection', target);
                }
                if (subdivision && originalSnapshot && target.scene === scene) {
                    try {
                        destroyRuntime(target);
                        await target.replaceSplatData(originalSnapshot);
                        applySubdivisionGroups(events, target, groupChanges, false);
                    } catch (rollbackError) {
                        console.error('[Paint] Failed to roll back decal subdivision', rollbackError);
                    }
                }
                console.error('[Paint] Failed to stamp decal', error);
            } finally {
                setBusy(false);
                if (!enabled) destroyRuntimes();
            }
        };

        const parameterAdjustmentPointerDown = (event: PointerEvent) => {
            const brushAdjustment = isBrushPaintTool(activePaintTool) && (event.shiftKey || event.altKey);
            const decalAdjustment = activePaintTool === 'decal' && event.altKey && !event.shiftKey;
            if (event.pointerType !== 'mouse' || (!brushAdjustment && !decalAdjustment) ||
                ![0, 1, 2].includes(event.button)) return false;

            const kind = event.button === 0 ? 'strength' : (event.button === 1 ? 'hardness' : 'radius');
            const decal = activePaintTool === 'decal';
            parameterAdjustment = {
                pointerId: event.pointerId,
                kind,
                axis: null,
                startX: event.clientX,
                startY: event.clientY,
                startValue: kind === 'strength' ? (decal ? decalStrength : strength) :
                    (kind === 'hardness' ? (decal ? decalFeather : hardness) : (decal ? decalSize : brushRadiusPixels))
            };
            updateAdjustmentCursor();
            parent.setPointerCapture(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
            return true;
        };

        const updateParameterAdjustment = (event: PointerEvent) => {
            if (!parameterAdjustment || parameterAdjustment.pointerId !== event.pointerId) return false;

            const range = parameterAdjustment.kind === 'radius' ? radiusDisplayMax - radiusDisplayMin : 1;
            const decal = activePaintTool === 'decal';
            const adjustedRange = parameterAdjustment.kind === 'radius' && decal ? decalSizeMax - decalSizeMin : range;
            const adjustment = paintParameterAdjustment(
                parameterAdjustment.startX,
                parameterAdjustment.startY,
                event.clientX,
                event.clientY,
                parameterAdjustment.axis
            );
            parameterAdjustment.axis = adjustment.axis;
            const delta = adjustment.delta / parameterAdjustmentPixels * adjustedRange;
            const value = parameterAdjustment.startValue + delta;

            if (parameterAdjustment.kind === 'strength') {
                if (decal) {
                    setDecalStrength(value);
                } else {
                    strength = clamp(value, 0, 1);
                    strengthInput.value = strength;
                    updateCursorGradient();
                }
            } else if (parameterAdjustment.kind === 'hardness') {
                if (decal) {
                    decalFeather = clamp(value, 0, 1);
                    decalFeatherInput.value = decalFeather;
                } else {
                    hardness = clamp(value, 0, 1);
                    hardnessInput.value = hardness;
                    updateCursorGradient();
                }
            } else {
                if (decal) {
                    decalSize = clamp(value, decalSizeMin, decalSizeMax);
                    decalSizeInput.value = decalSize;
                    updateDecalCursorSize();
                } else {
                    setRadiusDisplayValue(value);
                }
            }

            updateAdjustmentCursor();

            event.preventDefault();
            event.stopPropagation();
            return true;
        };

        const parameterAdjustmentPointerUp = (event: PointerEvent) => {
            if (!parameterAdjustment || parameterAdjustment.pointerId !== event.pointerId) return false;
            if (parent.hasPointerCapture(event.pointerId)) parent.releasePointerCapture(event.pointerId);
            parameterAdjustment = null;
            updateAdjustmentCursor();
            event.preventDefault();
            event.stopPropagation();
            return true;
        };

        const pointerdown = (event: PointerEvent) => {
            if (!enabled) return;

            const isPaintPointer = event.pointerType === 'mouse' ? event.button === 0 : event.isPrimary;
            const isMiddlePick = event.pointerType === 'mouse' && event.button === 1 && event.shiftKey &&
                !isBrushPaintTool(activePaintTool) &&
                (!event.altKey || activePaintTool !== 'decal');

            // The brush owns the primary pointer for the entire paint mode,
            // even when there is currently no valid Gaussian target. Consume
            // it before any early return so the ancestor camera controller
            // never begins an orbit/fly drag from the same pointer sequence.
            if (isBrushPaintTool(activePaintTool) && isPaintPointer) {
                event.preventDefault();
                event.stopPropagation();
            }

            if (committing || pointerId !== null || parameterAdjustment) return;

            if (isMiddlePick || (activePaintTool === 'eyedropper' && isPaintPointer)) {
                event.preventDefault();
                event.stopPropagation();
                colorSamplePointerId = event.pointerId;
                parent.setPointerCapture(colorSamplePointerId);
                enqueueScreenColorSample({ clientX: event.clientX, clientY: event.clientY });
                return;
            }

            if ((isBrushPaintTool(activePaintTool) || activePaintTool === 'decal') && parameterAdjustmentPointerDown(event)) return;
            if (!isPaintPointer) return;
            if ((isBrushPaintTool(activePaintTool) || activePaintTool === 'decal') &&
                events.functions.has('paint.layers.activeVisible') && !events.invoke('paint.layers.activeVisible')) return;

            if (activePaintTool === 'decal') {
                event.preventDefault();
                event.stopPropagation();
                const point = getPoint(event);
                updateCursorPosition(event);
                stampDecal(point);
                return;
            }

            if (!isBrushPaintTool(activePaintTool)) return;

            const point = getPoint(event);

            const target = getTarget();
            if (!target) return;

            let runtime: SplatPaintRuntime;
            try {
                runtime = getRuntime(target, activePaintTool !== 'eraser');
            } catch (error) {
                console.error('[Paint] Failed to initialize paint resources', error);
                return;
            }

            pointerId = event.pointerId;
            parent.setPointerCapture(pointerId);
            strokeGeneration++;
            strokeActive = true;
            strokeTarget = target;
            strokeRuntime = runtime;
            strokeRuntime.clear();
            strokeTool = activePaintTool;
            strokeLayerId = events.functions.has('paint.layers.active') ? events.invoke('paint.layers.active') as string : null;
            strokeAttachedSplats = activePaintTool === 'eraser' && events.functions.has('paint.layers.attachedSplats') ?
                new Set(events.invoke('paint.layers.attachedSplats', strokeLayerId ?? undefined) as Splat[]) : new Set();
            strokeEraseRuntimes = new Map();
            strokeSettings = {
                color: activePaintTool === 'eraser' ? new Color(1, 1, 1, 1) : paintColor.clone(),
                strength,
                hardness,
                radiusPixels: brushRadiusPixels
            };
            lastModelPoint = null;
            lastModelRadius = 0;
            lastPaintSplat = null;
            queuedPoint = null;
            enqueuePoint(point);
        };

        const pointermove = (event: PointerEvent) => {
            if (!enabled) return;
            const point = getPoint(event);
            updateCursorPosition(event);
            if (event.pointerId === colorSamplePointerId) {
                event.preventDefault();
                event.stopPropagation();
                enqueueScreenColorSample({ clientX: event.clientX, clientY: event.clientY });
                return;
            }
            if (updateParameterAdjustment(event)) return;
            if (event.pointerId === pointerId && strokeActive) {
                event.preventDefault();
                event.stopPropagation();
                enqueuePoint(point);
            }
        };

        const pointerup = async (event: PointerEvent) => {
            if (event.pointerId === colorSamplePointerId) {
                event.preventDefault();
                event.stopPropagation();
                enqueueScreenColorSample({ clientX: event.clientX, clientY: event.clientY });
                releaseColorSamplePointer();
                return;
            }
            if (parameterAdjustmentPointerUp(event)) return;
            if (event.pointerId !== pointerId || !strokeActive) return;

            event.preventDefault();
            event.stopPropagation();
            const point = getPoint(event);
            enqueuePoint(point);
            releasePointer();
            const generation = strokeGeneration;
            await waitForSamples();
            if (generation !== strokeGeneration || !strokeActive || !strokeRuntime || !strokeTarget) return;

            strokeActive = false;
            const runtime = strokeRuntime;
            const target = strokeTarget;
            const tool = strokeTool;
            const layerId = strokeLayerId;
            const eraseRuntimes = new Map(strokeEraseRuntimes);
            if (tool === 'eraser') eraseRuntimes.set(target, runtime);
            strokeRuntime = null;
            strokeTarget = null;
            strokeSettings = null;
            strokeTool = null;
            strokeLayerId = null;
            strokeAttachedSplats = new Set();
            strokeEraseRuntimes = new Map();
            lastModelPoint = null;
            lastModelRadius = 0;
            lastPaintSplat = null;

            setBusy(true);
            try {
                if (tool === 'eraser') {
                    const operations: EditOp[] = [];
                    for (const [eraseSplat, eraseRuntime] of eraseRuntimes) {
                        const delta = await eraseRuntime.commitErase();
                        if (!delta || !eraseSplat.scene) continue;

                        if (eraseSplat === target) {
                            // Unlike painting, color erasing does not directly
                            // mutate the Splat. History redo recomposes the layer.
                            operations.push(wrapPaintOperation(new PaintEraseOp({
                                splat: target,
                                indices: delta.indices,
                                strengths: delta.strengths
                            }), layerId));
                        } else {
                            // Shrinkwrapped decals are real Gaussians attached
                            // to the active layer, so erase their hit points by
                            // setting the same reversible deleted state used by
                            // normal Gaussian editing.
                            const ranges = IndexRanges.fromPredicate(
                                eraseSplat.splatData.numSplats,
                                sortedPredicate(delta.indices)
                            );
                            if (!ranges.empty) {
                                operations.push(new StateOp(eraseSplat, ranges, State.deleted, BitOp.SET, State.deleted));
                            }
                        }
                    }
                    if (operations.length > 0) {
                        events.fire('edit.add', operations.length === 1 ? operations[0] : new MultiOp(operations));
                    }
                } else {
                    const delta = await runtime.commit();
                    if (delta && target.scene) {
                        events.fire('edit.add', wrapPaintOperation(new PaintStrokeOp({
                            splat: target,
                            indices: delta.indices,
                            before: delta.before,
                            after: delta.after,
                            colors: delta.colors
                        }), layerId), true);
                    }
                }
            } catch (error) {
                runtime.clear();
                eraseRuntimes.forEach(eraseRuntime => eraseRuntime.clear());
                console.error('[Paint] Failed to commit stroke', error);
            } finally {
                setBusy(false);
                if (!enabled) destroyRuntimes();
            }
        };

        const pointercancel = (event: PointerEvent) => {
            if (event.pointerId === colorSamplePointerId) {
                event.preventDefault();
                event.stopPropagation();
                releaseColorSamplePointer();
                queuedColorSample = null;
                colorSampleToken++;
                return;
            }
            if (parameterAdjustmentPointerUp(event)) return;
            if (event.pointerId === pointerId) {
                event.preventDefault();
                event.stopPropagation();
                cancelStroke();
            }
        };

        const contextmenu = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
        };

        strengthInput.on('change', () => {
            strength = clamp(strengthInput.value ?? strength, 0, 1);
            updateCursorGradient();
        });

        hardnessInput.on('change', () => {
            hardness = clamp(hardnessInput.value ?? hardness, 0, 1);
            updateCursorGradient();
        });

        radiusInput.on('change', () => {
            if (updatingRadiusInput) return;
            const displayRadius = clamp(radiusInput.value ?? brushRadiusPixels, radiusDisplayMin, radiusDisplayMax);
            setRadiusDisplayValue(displayRadius);
        });

        decalStrengthInput.on('change', () => {
            setDecalStrength(decalStrengthInput.value ?? decalStrength);
        });

        decalFeatherInput.on('change', () => {
            decalFeather = clamp(decalFeatherInput.value ?? decalFeather, 0, 1);
        });

        decalSizeInput.on('change', () => {
            decalSize = clamp(decalSizeInput.value ?? decalSize, decalSizeMin, decalSizeMax);
            decalSizeInput.value = decalSize;
            updateDecalCursorSize();
        });

        decalSubdivisionInput.on('change', () => {
            if (decalMode === 'shrinkwrap') {
                decalSimplificationLevel = Math.round(clamp(
                    decalSubdivisionInput.value ?? decalSimplificationLevel,
                    decalSimplificationLevelMin,
                    decalSimplificationLevelMax
                ));
                decalSubdivisionInput.value = decalSimplificationLevel;
            } else {
                decalSubdivisionLevel = Math.round(clamp(
                    decalSubdivisionInput.value ?? decalSubdivisionLevel,
                    decalSubdivisionLevelMin,
                    decalSubdivisionLevelMax
                ));
                decalSubdivisionInput.value = decalSubdivisionLevel;
            }
        });

        const adjustBrushRadius = (delta: number) => {
            if (!enabled) return;
            if (activePaintTool === 'decal') {
                decalSize = clamp(decalSize + delta * decalSizeStep / radiusStep, decalSizeMin, decalSizeMax);
                decalSizeInput.value = decalSize;
                updateDecalCursorSize();
                return;
            }
            if (!isBrushPaintTool(activePaintTool)) return;
            setRadiusDisplayValue(brushRadiusPixels + delta);
        };

        events.on('tool.brushSelection.smaller', () => adjustBrushRadius(-radiusStep));
        events.on('tool.brushSelection.bigger', () => adjustBrushRadius(radiusStep));

        events.function('paint.strokeActive', () => strokeActive);
        events.function('paint.busy', () => committing);
        events.function('paint.tool', () => activePaintTool);
        events.function('paint.decal.mode', () => decalMode);
        events.function('paint.color', () => paintColor.clone());
        events.function('paint.decal.brightness', () => decalBrightness);
        events.function('paint.decal.mixStrength', () => decalMixStrength);
        events.on('paint.cancelStroke', cancelStroke);
        events.on('selection.changed', () => {
            // A stroke must never finish against a Gaussian that stopped being
            // the current selection while asynchronous pick samples were in flight.
            if (enabled && strokeActive && getTarget() !== strokeTarget) cancelStroke();
        });
        events.on('paint.color.set', (value: Color | number[] | string) => {
            setPaintColor(value);
            processDecalImage();
        });
        events.on('paint.decal.brightness.set', (value: number) => {
            decalBrightness = clamp(value, 0, 1);
            processDecalImage();
            events.fire('paint.decal.brightness.changed', decalBrightness);
        });
        events.on('paint.decal.mixStrength.set', (value: number) => {
            decalMixStrength = clamp(value, 0, 1);
            processDecalImage();
            events.fire('paint.decal.mixStrength.changed', decalMixStrength);
        });
        events.on('paint.decal.mode.set', (mode: DecalMode) => {
            if (!['subdivide', 'shrinkwrap'].includes(mode) || decalMode === mode) return;
            decalMode = mode;
            syncDecalDensityControl();
            syncDecalStrengthControl();
            processDecalImage();
            events.fire('paint.decal.mode.changed', decalMode);
        });
        events.on('paint.tool.set', (toolName: PaintToolName) => {
            if (!['brush', 'eraser', 'eyedropper', 'decal'].includes(toolName)) return;
            if (activePaintTool === toolName) return;
            if (strokeActive) cancelStroke();
            if (parameterAdjustment) {
                if (parent.hasPointerCapture(parameterAdjustment.pointerId)) {
                    parent.releasePointerCapture(parameterAdjustment.pointerId);
                }
                parameterAdjustment = null;
            }
            activePaintTool = toolName;
            updatePaintToolbar(activePaintTool);
            updateAdjustmentCursor();
            events.fire('paint.tool.changed', activePaintTool);
        });

        events.on('scene.elementRemoved', (element: unknown) => {
            if (!(element instanceof Splat)) return;
            if (element === strokeTarget) cancelStroke();
            const runtime = this.runtimes.get(element);
            if (runtime) {
                runtime.destroy();
                this.runtimes.delete(element);
            }
        });

        this.activate = () => {
            enabled = true;
            activePaintTool = 'brush';
            updatePaintToolbar(activePaintTool);
            events.fire('paint.tool.changed', activePaintTool);
            syncBrushRadiusUi();
            parent.style.display = 'block';
            svg.classList.remove('hidden');
            toolbar.hidden = false;
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('pointercancel', pointercancel);
            document.addEventListener('pointermove', updateCursorPosition, true);
            canvasContainer.dom.addEventListener('contextmenu', contextmenu);
        };

        this.deactivate = () => {
            enabled = false;
            releaseColorSamplePointer();
            queuedColorSample = null;
            colorSampleToken++;
            if (parameterAdjustment) {
                if (parent.hasPointerCapture(parameterAdjustment.pointerId)) parent.releasePointerCapture(parameterAdjustment.pointerId);
                parameterAdjustment = null;
                updateAdjustmentCursor();
            }
            if (strokeActive) cancelStroke();
            svg.classList.add('hidden');
            decalCursor.classList.add('hidden');
            toolbar.hidden = true;
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('pointercancel', pointercancel);
            document.removeEventListener('pointermove', updateCursorPosition, true);
            canvasContainer.dom.removeEventListener('contextmenu', contextmenu);
            if (!committing) destroyRuntimes();
        };

        setPaintColor(paintColor);
    }
}

export { PaintTool };
