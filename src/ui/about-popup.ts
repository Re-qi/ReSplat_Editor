import { Container, Label } from '@playcanvas/pcui';

import { version as appVersion } from '../../package.json';
import { openUrl } from '../open-url';

const logoImage = '<img src="./static/icons/Logo512x512.png" alt="ReSplat logo" width="64" height="64">';

class AboutPopup extends Container {
    constructor(args = {}) {
        args = {
            ...args,
            id: 'about-popup',
            hidden: true,
            tabIndex: -1
        };

        super(args);

        // Handle keyboard events
        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.hidden = true;
            }
            e.stopPropagation();
        });

        // Close when clicking outside dialog
        this.on('click', () => {
            this.hidden = true;
        });

        const dialog = new Container({
            id: 'about-dialog'
        });

        // Prevent clicks inside dialog from closing
        dialog.on('click', (event: MouseEvent) => {
            event.stopPropagation();
        });

        // Header bar
        const header = new Label({
            id: 'about-header',
            text: 'About'
        });

        // Content area
        const content = new Container({
            id: 'about-content'
        });

        // Logo
        const logoContainer = new Container({
            id: 'about-logo'
        });
        logoContainer.dom.innerHTML = logoImage;
        logoContainer.dom.addEventListener('click', () => {
            openUrl('https://github.com/Re-qi/ReSplat_Editor');
        });

        // App name and version
        const appInfo = new Container({
            id: 'about-app-info'
        });
        appInfo.dom.addEventListener('click', () => {
            openUrl('https://github.com/Re-qi/ReSplat_Editor');
        });

        const appName = new Label({
            id: 'about-app-name',
            text: 'ReSplat'
        });

        const appVersionLabel = new Label({
            id: 'about-app-version',
            text: `v${appVersion}`
        });

        appInfo.append(appName);
        appInfo.append(appVersionLabel);

        // Dependencies
        const depsContainer = new Container({
            id: 'about-deps'
        });

        // Contact
        const contactRow = new Container({
            class: 'about-dep-row'
        });
        const contactText = new Label({ class: 'about-dep-name', text: '联系我：reqi24@foxmail.com' });
        contactRow.append(contactText);

        // Powered by
        const poweredByRow = new Container({
            class: 'about-dep-row'
        });
        const poweredByText = new Label({ class: 'about-dep-name', text: 'powered by SuperSplat' });
        poweredByRow.append(poweredByText);

        // NanoGS attribution — CC BY-NC 4.0 (adapted material, see src/nanogs/README.md)
        const nanogsRow = new Container({
            class: 'about-dep-row'
        });
        const nanogsText = new Label({ class: 'about-dep-name', text: 'simplification by NanoGS (CC BY-NC 4.0)' });
        nanogsRow.append(nanogsText);
        nanogsRow.dom.addEventListener('click', () => {
            openUrl('https://github.com/RongLiu-Leo/NanoGS');
        });

        depsContainer.append(contactRow);
        depsContainer.append(poweredByRow);
        depsContainer.append(nanogsRow);

        // Assemble content
        content.append(logoContainer);
        content.append(appInfo);
        content.append(depsContainer);

        // Assemble dialog
        dialog.append(header);
        dialog.append(content);

        this.append(dialog);

        // Focus when shown so keyboard events work
        this.on('show', () => {
            this.dom.focus();
        });
    }
}

export { AboutPopup };
