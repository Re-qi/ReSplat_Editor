type NumberedPaintLayer = {
    name: string;
    deleted?: boolean;
};

const TRAILING_LAYER_NUMBER = /(?:^|\s)([1-9]\d*)$/;

const nextAvailablePaintLayerNumber = (layers: NumberedPaintLayer[]) => {
    const used = new Set<number>();
    for (const layer of layers) {
        if (layer.deleted) continue;
        const match = TRAILING_LAYER_NUMBER.exec(layer.name);
        if (match) used.add(Number(match[1]));
    }

    let number = 1;
    while (used.has(number)) number++;
    return number;
};

export { nextAvailablePaintLayerNumber };
