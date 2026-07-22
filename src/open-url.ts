/**
 * Open a URL in the system default browser.
 * In Electron, uses shell.openExternal; in browser, uses window.open.
 */
function openUrl(url: string): void {
    const api = (window as any).electronAPI;
    if (api?.openExternal) {
        api.openExternal(url);
    } else {
        window.open(url, '_blank')?.focus();
    }
}

export { openUrl };
