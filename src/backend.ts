/**
 * BackendClient — frontend client for the ReSplat local backend.
 *
 * Provides health-check detection and decimate API calls.
 * When the backend is available, large file operations are offloaded
 * to Node.js, bypassing the browser's ~4GB V8 memory limit.
 */

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
     * Generate multi-level LOD compressed-ply files from a PLY path.
     * Returns an array of { level, count, url, sizeBytes } for progressive loading.
     *
     * @param filePath - Absolute path to the PLY file on disk
     * @param levels - Array of LOD percentages (default [5, 25, 100])
     */
    static async lodConvertPath(
        filePath: string,
        levels: number[] = [100]
    ): Promise<{
        levels: Array<{ level: number; count: number; url: string; sizeBytes: number }>;
        totalSeconds: number;
    }> {
        const res = await fetch(`${this.BASE_URL}/api/lod-convert-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath, levels })
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
