import { Events } from './events';

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
        try {
            const response = await fetch(
                'https://api.github.com/repos/Re-qi/ReSplat/releases/latest',
                { headers: { Accept: 'application/vnd.github.v3+json' } }
            );
            if (!response.ok) {
                throw new Error(`GitHub API returned ${response.status}`);
            }
            const data = await response.json();
            const tagName: string = data.tag_name || '';
            this.latestVersion = tagName.startsWith('v') ? tagName.slice(1) : tagName;
            this.releaseUrl = data.html_url || `https://github.com/Re-qi/ReSplat/releases/tag/${tagName}`;

            if (this.compareVersions(this.latestVersion, this.currentVersion) > 0) {
                this.state = { status: 'available', url: this.releaseUrl };
            } else {
                this.state = { status: 'latest' };
            }
        } catch (err) {
            console.error('[version-check] Failed to check for updates:', err);
            this.state = { status: 'error' };
        }
        this.events.fire('versionCheck.changed', this.state);
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
