/// <reference types="@webgpu/types" />
/// <reference types="wicg-file-system-access" />

interface FileSystemFileHandle {
    remove(): Promise<void>;
}

declare module '*.png' {
    const value: any;
    export default value;
}

declare module '*.svg' {
    const value: any;
    export default value;
}

declare module '*.scss' {
    const value: any;
    export default value;
}

interface ElectronAPI {
    isElectron: boolean;
    hasWebGPU: boolean;
    openFileDialog: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string[]>;
    openFolderDialog: () => Promise<string | null>;
    saveFileDialog: (options?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>;
    readFile: (filePath: string) => Promise<Uint8Array>;
    fileExists: (filePath: string) => Promise<boolean>;
    readDir: (dirPath: string) => Promise<string[]>;
}

interface Window {
    electronAPI?: ElectronAPI;
}
