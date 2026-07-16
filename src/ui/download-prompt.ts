import { BackendClient } from '../backend';
import { Events } from '../events';

/**
 * Show a prompt guiding the user to download the local version of ReSplat
 * when they attempt to load a file that requires more memory than the
 * browser can provide.
 *
 * @param events - Application event bus
 * @param fileInfo - Human-readable file description
 * @param gaussianCount - Number of Gaussians in the file
 * @param estMemMB - Estimated memory requirement in MB
 */
async function showDownloadPrompt(
    events: Events,
    fileInfo: string,
    gaussianCount: number,
    estMemMB: number
): Promise<void> {
    const localVersionUrl = 'https://github.com/mkkellogg/ReSplat';

    await events.invoke('showPopup', {
        type: 'info',
        header: '需要本地版 ReSplat',
        message:
            `文件 "${fileInfo}" 包含 ${gaussianCount.toLocaleString()} 个高斯点 ` +
            `（预计需要 ${estMemMB} MB 内存），超出了浏览器内存限制（约 4 GB）。\n\n` +
            '请下载本地版 ReSplat 来处理此文件。本地版使用 Node.js 后端 ' +
            '突破了浏览器内存限制，支持超大文件的导入、导出和合并。\n\n' +
            '如果您已安装本地版，请先启动后端服务，然后刷新此页面。',
        link: localVersionUrl
    });
}

/**
 * Show a prompt for the merge feature when backend is not available.
 */
async function showMergeUnavailablePrompt(events: Events): Promise<void> {
    const localVersionUrl = 'https://github.com/mkkellogg/ReSplat';

    await events.invoke('showPopup', {
        type: 'info',
        header: '合并功能需要本地版',
        message:
            '合并多个大型高斯点云文件需要本地版 ReSplat。\n\n' +
            '本地版使用 Node.js 后端突破了浏览器内存限制，' +
            '支持对大文件进行合并操作。\n\n' +
            '如果您已安装本地版，请先启动后端服务，然后刷新此页面。',
        link: localVersionUrl
    });
}

export { showDownloadPrompt, showMergeUnavailablePrompt };
