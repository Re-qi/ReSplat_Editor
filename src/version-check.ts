import { Events } from './events';

const QUARK_PWD_ID = '128e4200b891';
const QUARK_SHARE_URL = `https://pan.quark.cn/s/${QUARK_PWD_ID}`;

interface UpdateState {
    status: 'checking' | 'available' | 'latest' | 'error';
    url?: string;
}

class VersionCheck {
    private events: Events;
    private currentVersion: string;
    private latestVersion: string | null = null;
    private releaseUrl: string | null = null;
    private state: UpdateState = { status: 'checking' };

    constructor(events: Events, currentVersion: string) {
        this.events = events;
        this.currentVersion = currentVersion;
        this.check();
    }

    getState(): UpdateState {
        return this.state;
    }

    private async check() {
        // Check GitHub first
        await this.checkGithub();
        // Then check Quark for possibly newer version
        await this.checkQuark();
    }

    private async checkGithub() {
        try {
            const response = await fetch(
                'https://api.github.com/repos/Re-qi/ReSplat_Editor/releases/latest',
                { headers: { Accept: 'application/vnd.github.v3+json' } }
            );
            if (!response.ok) {
                throw new Error(`GitHub API returned ${response.status}`);
            }
            const data = await response.json();
            const tagName: string = data.tag_name || '';
            this.latestVersion = tagName.startsWith('v') ? tagName.slice(1) : tagName;
            this.releaseUrl = data.html_url || `https://github.com/Re-qi/ReSplat_Editor/releases/tag/${tagName}`;

            if (this.compareVersions(this.latestVersion, this.currentVersion) > 0) {
                this.state = { status: 'available', url: this.releaseUrl };
            } else {
                this.state = { status: 'latest' };
            }
        } catch (err) {
            console.error('[version-check] GitHub check failed:', err);
            this.state = { status: 'error' };
        }
        this.events.fire('versionCheck.changed', this.state);
    }

    private async checkQuark() {
        try {
            // Step 1: get stoken
            const tokenResp = await fetch(
                'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
                {
                    method: 'POST',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Content-Type': 'application/json',
                        'Origin': 'https://pan.quark.cn',
                        'Referer': 'https://pan.quark.cn/'
                    },
                    body: JSON.stringify({ pwd_id: QUARK_PWD_ID, passcode: '' })
                }
            );
            if (!tokenResp.ok) {
                throw new Error(`Quark token API returned ${tokenResp.status}`);
            }
            const tokenData = await tokenResp.json();
            const stoken: string = tokenData?.data?.stoken;
            if (!stoken) {
                throw new Error('No stoken from Quark API');
            }

            // Step 2: get root folder listing
            const ts = Date.now();
            const dt = Math.floor(Math.random() * 9000) + 1000;
            const rootResp = await fetch(
                `https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=${QUARK_PWD_ID}&stoken=${stoken}&pdir_fid=0&force=0&_page=1&_size=50&_sort=file_type:asc,updated_at:desc&__dt=${dt}&__t=${ts}`,
                {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Origin': 'https://pan.quark.cn',
                        'Referer': 'https://pan.quark.cn/'
                    }
                }
            );
            if (!rootResp.ok) throw new Error(`Quark root API returned ${rootResp.status}`);
            const rootData = await rootResp.json();

            // Find the ReSplat folder
            const rootList = rootData?.data?.list || [];
            const resplatFolder = rootList.find((f: any) => f.file_name === 'ReSplat' && f.dir);
            if (!resplatFolder) {
                throw new Error('No ReSplat folder found in Quark share');
            }

            // Step 3: get files inside the ReSplat folder
            const folderResp = await fetch(
                `https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc&pwd_id=${QUARK_PWD_ID}&stoken=${stoken}&pdir_fid=${resplatFolder.fid}&force=0&_page=1&_size=50&_sort=file_type:asc,updated_at:desc&__dt=${dt + 1}&__t=${ts + 1}`,
                {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Origin': 'https://pan.quark.cn',
                        'Referer': 'https://pan.quark.cn/'
                    }
                }
            );
            if (!folderResp.ok) throw new Error(`Quark folder API returned ${folderResp.status}`);
            const folderData = await folderResp.json();

            // Find the installer file and extract version
            const files = folderData?.data?.list || [];
            const installer = files.find((f: any) => f.file_name?.startsWith('ReSplat Setup ') && f.file_name?.endsWith('.exe'));
            if (!installer) {
                throw new Error('No installer found in Quark ReSplat folder');
            }

            const match = installer.file_name.match(/ReSplat Setup (\d+\.\d+\.\d+)\.exe/);
            if (!match) {
                throw new Error('Could not extract version from installer filename');
            }

            const quarkVersion = match[1];
            console.log(`[version-check] Quark version: ${quarkVersion}, current: ${this.currentVersion}`);

            // Only update state if Quark has a newer version
            if (this.compareVersions(quarkVersion, this.currentVersion) > 0) {
                const isNewerThanGithub = !this.latestVersion || this.compareVersions(quarkVersion, this.latestVersion) > 0;
                if (isNewerThanGithub) {
                    this.state = { status: 'available', url: QUARK_SHARE_URL };
                    this.events.fire('versionCheck.changed', this.state);
                }
            }
        } catch (err) {
            console.error('[version-check] Quark check failed:', err);
            // Don't change state if Quark check fails — keep GitHub result
        }
    }

    private compareVersions(a: string, b: string): number {
        const partsA = a.split('.').map(Number);
        const partsB = b.split('.').map(Number);
        const len = Math.max(partsA.length, partsB.length);
        for (let i = 0; i < len; i++) {
            const na = partsA[i] || 0;
            const nb = partsB[i] || 0;
            if (na > nb) return 1;
            if (na < nb) return -1;
        }
        return 0;
    }
}

export { VersionCheck };
export type { UpdateState };
