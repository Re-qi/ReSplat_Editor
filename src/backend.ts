/**
 * BackendClient — frontend client for the ReSplat local backend.
 *
 * Provides health-check detection and decimate API calls.
 * When the backend is available, large file operations are offloaded
 * to Node.js, bypassing the browser's ~4GB V8 memory limit.
 */

import { Quat, type GSplatData } from 'playcanvas';

import { loadGSplatData, MappedReadFileSystem } from './io';

// Route a LOD load through the backend when its worst-case quality table
// (59 cols × 4B) would strain the renderer heap. A direct load peaks at ~2.5×
// the table (materialize + Morton permute + GSplatData), so route when the
// table exceeds limit/2.5 — adapting to the ACTUAL V8 heap limit (4GB in the
// web build, up to 16GB in Electron) rather than a hardcoded number. Floored
// at 2 GB so very small heaps still route early.
export const lodNeedsBackend = (numSplats: number): boolean => {
    const tableBytes = numSplats * 59 * 4;
    const mem = (typeof performance !== 'undefined' ? (performance as any).memory : undefined) as
        { jsHeapSizeLimit?: number } | undefined;
    const limit = mem?.jsHeapSizeLimit ?? 4 * 1024 ** 3;
    return tableBytes > Math.max(2 * 1024 ** 3, limit / 2.5);
};

class BackendClient {
    static readonly BASE_URL = 'http://localhost:3266';
    private static _available: boolean | null = null; // null = unchecked

    /**
     * Check if the local backend is reachable.
     * Result is cached after first call.
     *
     * In Electron mode the Express server is embedded in the main process,
     * so we skip the health-check fetch and return true immediately. This
     * also avoids a startup race: the renderer may boot before the server
     * is listening, causing a cached false.
     */
    static async isAvailable(): Promise<boolean> {
        if (this._available !== null) return this._available;
        // Electron embeds the Express server — always available
        if (typeof window !== 'undefined' && (window as any).electronAPI?.isElectron) {
            this._available = true;
            return true;
        }
        try {
            const res = await fetch(`${this.BASE_URL}/api/health`, {
                signal: AbortSignal.timeout(500)
            });
            const json = await res.json();
            this._available = !!(res.ok && json.ok);
        } catch {
            this._available = false;
        }
        return this._available;
    }

    /**
     * Reset cached availability. Useful when the user starts the backend
     * after the app has already loaded.
     */
    static resetAvailability(): void {
        this._available = null;
    }

    /**
     * Send a file to the backend for decimation (MPMM merging).
     *
     * @param file - The source splat file (SOG, PLY, etc.)
     * @param targetPercent - Percentage of Gaussians to retain (1-100)
     * @returns The decimated file as a Blob
     */
    static async decimate(
        file: File,
        targetPercent: number
    ): Promise<{ blob: Blob; filename: string }> {
        const form = new FormData();
        form.append('file', file);
        form.append('targetPercent', String(targetPercent));

        const res = await fetch(`${this.BASE_URL}/api/decimate`, {
            method: 'POST',
            body: form
        });

        if (!res.ok) {
            let errorMsg = `Decimate failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const filenameMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        const filename = filenameMatch?.[1]?.replace(/['"]/g, '') || file.name;

        return { blob, filename };
    }

    /**
     * Convert a file to SOG format without decimation.
     * Useful when browser can't parse PLY directly but no size reduction is needed.
     *
     * @param file - The source splat file (PLY, etc.)
     * @returns The converted SOG file as a Blob
     */
    static async convert(
        file: File
    ): Promise<{ blob: Blob; filename: string }> {
        const form = new FormData();
        form.append('file', file);

        const res = await fetch(`${this.BASE_URL}/api/convert`, {
            method: 'POST',
            body: form
        });

        if (!res.ok) {
            let errorMsg = `Convert failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        const blob = await res.blob();
        const disposition = res.headers.get('Content-Disposition') || '';
        const filenameMatch = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        const filename = filenameMatch?.[1]?.replace(/['"]/g, '') || file.name;

        return { blob, filename };
    }

    /**
     * Decimate a file by disk path — no HTTP upload, backend reads directly.
     * Output written to temp/ dir, served via static URL.
     *
     * @param filePath - Absolute path to the file on disk
     * @param targetPercent - Percentage of Gaussians to retain (1-100)
     * @returns URL to download the result + filename + count
     */
    static async decimatePath(
        filePath: string,
        targetPercent: number
    ): Promise<{ url: string; filename: string; count: number }> {
        const res = await fetch(`${this.BASE_URL}/api/decimate-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath, targetPercent })
        });

        if (!res.ok) {
            let errorMsg = `Decimate failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        return res.json();
    }

    /**
     * Convert a file by disk path to PLY — no HTTP upload, no decimation.
     * Output written to temp/ dir, served via static URL.
     *
     * @param filePath - Absolute path to the file on disk
     * @returns URL to download the result + filename + count
     */
    static async convertPath(
        filePath: string
    ): Promise<{ url: string; filename: string; count: number }> {
        const res = await fetch(`${this.BASE_URL}/api/convert-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath })
        });

        if (!res.ok) {
            let errorMsg = `Convert failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        return res.json();
    }

    /**
     * Generate multi-level compressed-ply files from a source path.
     * Returns an array of { level, count, url, sizeBytes } for progressive loading.
     * For multi-LOD containers (.lcc/.lcc2), `lodIndex` selects which LOD to
     * compress (default 0 = finest).
     *
     * @param filePath - Absolute path to the source file on disk
     * @param levels - Array of LOD percentages (default [5, 25, 100])
     * @param lodIndex - For multi-LOD containers, the LOD level to compress
     */
    static async lodConvertPath(
        filePath: string,
        levels: number[] = [100],
        lodIndex = 0
    ): Promise<{
        levels: Array<{ level: number; count: number; url: string; sizeBytes: number }>;
        totalSeconds: number;
        transformRotation?: [number, number, number, number] | null;
    }> {
        const res = await fetch(`${this.BASE_URL}/api/lod-convert-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath, levels, lodIndex })
        });

        if (!res.ok) {
            let errorMsg = `LOD convert failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        return res.json();
    }

    /**
     * Compress a single LOD of a multi-LOD container via the backend and load
     * it as a GSplatData (SOURCE space — the backend does not bake, so the
     * data matches loadLodDataTable's output and stays aligned with the other
     * levels under the splat's entity rotation).
     *
     * Used by the LOD switcher and the import LOD picker to open LODs whose
     * quality table would exceed the renderer heap ("Array buffer allocation
     * failed") without the renderer parsing the raw multi-GB container.
     *
     * @param filePath - Absolute path to the container on disk
     * @param lodIndex - Which LOD to compress (0 = finest)
     * @returns Loaded GSplatData + the source transform rotation (for the
     * import path, which has no old splat to inherit the rotation from), or
     * null when the backend is unavailable.
     */
    static async loadLodPreview(
        filePath: string,
        lodIndex: number
    ): Promise<{ gsplatData: GSplatData; rotation: Quat | null } | null> {
        if (!(await this.isAvailable())) return null;
        const { levels, transformRotation } = await this.lodConvertPath(filePath, [100], lodIndex);
        const blob = await (await fetch(levels[0].url)).blob();
        const fs = new MappedReadFileSystem();
        fs.addFile('preview.compressed.ply', blob);
        const loaded = await loadGSplatData('preview.compressed.ply', fs);
        if (!loaded) return null;
        const rotation = transformRotation ? new Quat(transformRotation) : null;
        return { gsplatData: loaded.gsplatData, rotation };
    }

    /**
     * Open a selection-driven LOD0 edit session. The selected non-zero LOD is
     * only a proxy in the renderer; page data is fetched after a spatial edit
     * asks for it.
     */
    static async openLodEdit(
        filePath: string,
        proxyLod: number
    ): Promise<{
        sessionId: string;
        version: number;
        sourceFingerprint: string;
        sourcePath: string;
        format: 'lcc' | 'lcc2';
        proxyLod: number;
        totalLods: number;
        totalPoints: number;
        bounds: { min: number[]; max: number[] };
        pageCount: number;
        workingSetBytes?: number;
        maxConcurrentPages?: number;
        pages: Array<{
            id: string;
            lod: number;
            count: number;
            bounds: { min: number[]; max: number[] };
            ranges: Array<{ start: number; count: number }>;
            sourceFile?: string | null;
        }>;
    }> {
        if (!(await this.isAvailable())) throw new Error('本地分页后端不可用');
        const res = await fetch(`${this.BASE_URL}/api/lod-edit/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath, proxyLod })
        });
        if (!res.ok) {
            let message = `LOD edit open failed: ${res.statusText}`;
            try {
                message = (await res.json()).error || message;
            } catch { /* default */ }
            throw new Error(message);
        }
        return res.json();
    }

    /** Load one LOD0 page and retain its stable source-row mapping. */
    static async loadLodEditPage(
        sessionId: string,
        pageId: string
    ): Promise<{
        pageId: string;
        count: number;
        sourceIndices: Uint32Array;
        gsplatData: GSplatData;
        bounds: { min: number[]; max: number[] };
        transform: {
            translation: number[];
            rotation: number[];
            scale: number;
        };
    }> {
        const res = await fetch(`${this.BASE_URL}/api/lod-edit/page/${encodeURIComponent(sessionId)}/${encodeURIComponent(pageId)}`);
        if (!res.ok) {
            let message = `LOD edit page failed: ${res.statusText}`;
            try {
                message = (await res.json()).error || message;
            } catch { /* default */ }
            throw new Error(message);
        }
        const payload = await res.json();
        const pageBlob = await (await fetch(`${payload.baseUrl}${payload.url}`)).blob();
        const pageFs = new MappedReadFileSystem();
        pageFs.addFile(`${pageId}.ply`, pageBlob);
        const loaded = await loadGSplatData(`${pageId}.ply`, pageFs, true);
        if (!loaded) throw new Error(`Failed to decode LOD edit page ${pageId}`);
        const sourceIndices = Uint32Array.from(payload.sourceIndices as number[]);
        if (sourceIndices.length !== loaded.gsplatData.numSplats) {
            throw new Error(`LOD edit page ${pageId} source index count mismatch`);
        }
        const element = loaded.gsplatData.getElement('vertex');
        element.properties.push({
            type: 'uint',
            name: 'source_index',
            storage: sourceIndices,
            byteSize: sourceIndices.BYTES_PER_ELEMENT
        });
        return {
            pageId,
            count: loaded.gsplatData.numSplats,
            sourceIndices,
            gsplatData: loaded.gsplatData,
            bounds: payload.bounds,
            // The temporary PLY has its own source-to-engine transform. It
            // must be used for exact selection because its coordinate basis
            // can differ from the resident proxy's source basis.
            transform: {
                translation: [loaded.transform.translation.x, loaded.transform.translation.y, loaded.transform.translation.z],
                rotation: [loaded.transform.rotation.x, loaded.transform.rotation.y, loaded.transform.rotation.z, loaded.transform.rotation.w],
                scale: loaded.transform.scale
            }
        };
    }

    static async closeLodEdit(sessionId: string): Promise<void> {
        if (!this._available) return;
        await fetch(`${this.BASE_URL}/api/lod-edit/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
        }).catch(() => {});
    }

    /**
     * Read PLY header from a file path — returns vertex count + estimated memory.
     */
    static async plyMeta(
        filePath: string
    ): Promise<{ count: number; estMemMB: number; numProps: number }> {
        const res = await fetch(`${this.BASE_URL}/api/ply-meta`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath })
        });

        if (!res.ok) {
            let errorMsg = `PLY meta failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        return res.json();
    }

    /**
     * Export a PLY file as LCC2 using the backend pipeline.
     * Writes {name}.lcc2 + data/3dgs/*.sog into outputDir/{name}/.
     *
     * The backend runs the export in a worker thread and returns a jobId
     * immediately; this method polls /api/lcc2-export-status until the job
     * finishes, invoking `onProgress` as progress updates arrive.
     *
     * @param filePath - Absolute path to the source PLY file on disk
     * @param outputDir - Parent directory (the backend creates {name}/ inside it)
     * @param options - Export settings
     * @param onProgress - Optional progress callback ({ progress, text })
     * @returns Export metadata when complete
     */
    static async lcc2ExportPath(
        filePath: string,
        outputDir: string,
        options: { name: string; lodLevels?: number; shBands?: number; iterations?: number; simplifyMethod?: 'nanogs' | 'uniform' },
        onProgress?: (progress: { progress: number; text?: string }) => void
    ): Promise<{
        outputPath: string;
        fileCount: number;
        totalSplats: number;
        totalLevels: number;
        lodSplats: number[];
        totalSeconds: number;
    }> {
        const res = await fetch(`${this.BASE_URL}/api/lcc2-export-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath, outputDir, ...options })
        });

        if (!res.ok) {
            let errorMsg = `LCC2 export failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        const { jobId } = await res.json();

        // Poll the job until it finishes. Exports can run for tens of minutes,
        // so no timeout — the backend cleans the job up 10 min after completion.
        for (;;) {
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
            const statusRes = await fetch(`${this.BASE_URL}/api/lcc2-export-status?jobId=${encodeURIComponent(jobId)}`);
            let status;
            try {
                status = await statusRes.json();
            } catch {
                throw new Error('LCC2 export failed: lost connection to backend');
            }
            if (status.status === 'error') {
                throw new Error(status.error || 'LCC2 export failed');
            }
            if (status.progress !== undefined || status.text !== undefined) {
                onProgress?.({ progress: status.progress ?? 0, text: status.text });
            }
            if (status.status === 'done') {
                return status.result;
            }
        }
    }

    /**
     * Export a source file as bundled-HTML viewer using the backend pipeline.
     * The backend reads the source fresh in a worker thread, spills columns to
     * disk and streams the SOG payload (base64) into the output HTML — peak
     * memory stays far below the renderer's ~4GB V8 cap, which the in-browser
     * path exceeds for large scenes (extractDataTable + writeSog repack).
     *
     * Same job pattern as lcc2ExportPath: POST returns a jobId immediately,
     * then poll /api/html-export-status until done/error.
     *
     * @param filePath - Absolute path to the source file on disk
     * @param outputPath - Absolute path of the .html file to write
     * @param options - { shBands, iterations, viewerSettings }
     * @param onProgress - Optional progress callback ({ progress, text })
     */
    static async htmlExportPath(
        filePath: string,
        outputPath: string,
        options: { shBands?: number; iterations?: number; viewerSettings?: unknown },
        onProgress?: (progress: { progress: number; text?: string }) => void
    ): Promise<{
        outputPath: string;
        numSplats: number;
        htmlBytes: number;
        sogBytes: number;
        totalSeconds: number;
    }> {
        const res = await fetch(`${this.BASE_URL}/api/html-export-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath, outputPath, ...options })
        });

        if (!res.ok) {
            let errorMsg = `HTML export failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        const { jobId } = await res.json();

        // Poll until finished. Large-scene exports run for minutes — no
        // timeout; the backend drops the job 10 min after completion.
        for (;;) {
            await new Promise((resolve) => {
                setTimeout(resolve, 500);
            });
            const statusRes = await fetch(`${this.BASE_URL}/api/html-export-status?jobId=${encodeURIComponent(jobId)}`);
            let status;
            try {
                status = await statusRes.json();
            } catch {
                throw new Error('HTML export failed: lost connection to backend');
            }
            if (status.status === 'error') {
                throw new Error(status.error || 'HTML export failed');
            }
            if (status.progress !== undefined || status.text !== undefined) {
                onProgress?.({ progress: status.progress ?? 0, text: status.text });
            }
            if (status.status === 'done') {
                return status.result;
            }
        }
    }

    /**
     * Merge multiple PLY files via backend C++ native engine.
     * Returns a compressed-ply URL that can be loaded as a new Splat.
     *
     * @param filePaths - Absolute paths to the PLY files on disk
     * @returns URL to download the merged compressed-ply + metadata
     */
    static async mergePath(
        filePaths: string[]
    ): Promise<{ url: string; filename: string; count: number; sizeBytes: number }> {
        const res = await fetch(`${this.BASE_URL}/api/merge-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePaths })
        });

        if (!res.ok) {
            let errorMsg = `Merge failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        return res.json();
    }

    /**
     * LOD convert via file upload — backend generates 3-level compressed-ply
     * (5%, 25%, 100%) for progressive loading. Used by auto-detection of large PLY.
     *
     * @param file - The PLY file blob to process
     * @param levels - LOD percentages, default [100]
     * @returns LOD level metadata: [{ level, count, url, sizeBytes }]
     */
    static async lodConvert(
        file: File,
        levels: number[] = [100]
    ): Promise<{ levels: Array<{ level: number; count: number; url: string; sizeBytes: number }>; totalSeconds: number }> {
        const formData = new FormData();
        formData.append('file', file);
        // levels passed as query-compatible; backend reads levels from body via multer fields isn't supported,
        // so we pass levels as a JSON string in a field
        formData.append('levels', JSON.stringify(levels));

        const res = await fetch(`${this.BASE_URL}/api/lod-convert`, {
            method: 'POST',
            body: formData
        });

        if (!res.ok) {
            let errorMsg = `LOD convert failed: ${res.statusText}`;
            try {
                const err = await res.json();
                errorMsg = err.error || errorMsg;
            } catch { /* use default */ }
            throw new Error(errorMsg);
        }

        return res.json();
    }
}

export { BackendClient };
