# ReSplat Editor

> **Powered by [supersplat-2.27.0](https://github.com/playcanvas/supersplat)** — This project is a fork/rebrand of the original SuperSplat editor.

[![Github Release](https://img.shields.io/github/v/release/playcanvas/supersplat)](https://github.com/playcanvas/supersplat/releases)
[![License](https://img.shields.io/github/license/playcanvas/supersplat)](https://github.com/playcanvas/supersplat/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-5865F2?style=flat&logo=discord&logoColor=white&color=black)](https://discord.gg/RSaMRzg)
[![Reddit](https://img.shields.io/badge/Reddit-FF4500?style=flat&logo=reddit&logoColor=white&color=black)](https://www.reddit.com/r/PlayCanvas)
[![X](https://img.shields.io/badge/X-000000?style=flat&logo=x&logoColor=white&color=black)](https://x.com/intent/follow?screen_name=playcanvas)

| [ReSplat Editor](https://superspl.at/editor) | [User Guide](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/ReSplat/) | [Blog](https://blog.playcanvas.com) | [Forum](https://forum.playcanvas.com) |

The ReSplat Editor is a free and open source tool for inspecting, editing, optimizing and publishing 3D Gaussian Splats. It is built on web technologies and runs in the browser, so there's nothing to download or install.

A live version of this tool is available at: https://superspl.at/editor

![image](https://github.com/user-attachments/assets/b6cbb5cc-d3cc-4385-8c71-ab2807fd4fba)

To learn more about using ReSplat, please refer to the [User Guide](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/ReSplat/).

## Local Development

To initialize a local development environment for ReSplat, ensure you have [Node.js](https://nodejs.org/) 18 or later installed. Follow these steps:

1. Clone the repository:

   ```sh
   git clone https://github.com/playcanvas/ReSplat.git
   cd ReSplat
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Build ReSplat and start a local web server:

   ```sh
   npm run develop
   ```

4. Open a web browser tab and make sure network caching is disabled on the network tab and the other application caches are clear:

   - On Safari you can use `Cmd+Option+e` or Develop->Empty Caches.
   - On Chrome ensure the options "Update on reload" and "Bypass for network" are enabled in the Application->Service workers tab:

   <img width="846" alt="Screenshot 2025-04-25 at 16 53 37" src="https://github.com/user-attachments/assets/888bac6c-25c1-4813-b5b6-4beecf437ac9" />

5. Navigate to `http://localhost:3000`

When changes to the source are detected, ReSplat is rebuilt automatically. Simply refresh your browser to see your changes.

## Localizing the ReSplat Editor

The currently supported languages are available here:

https://github.com/playcanvas/ReSplat/tree/main/static/locales

### Adding a New Language

1. Add a new `<locale>.json` file in the `static/locales` directory.

2. Add the locale to the list here:

   https://github.com/playcanvas/ReSplat/blob/main/src/ui/localization.ts

### Testing Translations

To test your translations:

1. Run the development server:

   ```sh
   npm run develop
   ```

2. Open your browser and navigate to:

   ```
   http://localhost:3000/?lng=<locale>
   ```

   Replace `<locale>` with your language code (e.g., `fr`, `de`, `es`).

## Contributors

ReSplat is made possible by our amazing open source community:

<a href="https://github.com/playcanvas/ReSplat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=playcanvas/ReSplat" />
</a>
