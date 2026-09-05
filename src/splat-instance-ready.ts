// A newly-created GSplatInstance starts with zero drawable instances. Its
// sorter uploads the first order buffer asynchronously; rendering or picking
// before that upload sees an empty point cloud.
const waitForSplatInstanceReady = (instance: any, cameraNode: any, timeoutMs = 5000): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
        const sorter = instance.sorter;
        let settled = false;

        function cleanup() {
            sorter.off('updated', onUpdated);
            clearTimeout(timeout);
        }

        function finishIfReady() {
            settled = true;
            instance.update();
            if (instance.meshInstance.instancingCount === 0) {
                settled = false;
                return false;
            }
            cleanup();
            resolve();
            return true;
        }

        function onUpdated() {
            if (settled) return;
            finishIfReady();
        }

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('Timed out while preparing the subdivided point cloud for rendering.'));
        }, timeoutMs);

        sorter.on('updated', onUpdated);
        if (!finishIfReady()) instance.sort(cameraNode);
    });
};

export { waitForSplatInstanceReady };
