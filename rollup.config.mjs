import path from 'path';

import alias from '@rollup/plugin-alias';
import image from '@rollup/plugin-image';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import strip from '@rollup/plugin-strip';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import scss from 'rollup-plugin-scss';
import sass from 'sass';

import copyAndWatch from './copy-and-watch.mjs';

// prod is release build
if (process.env.BUILD_TYPE === 'prod') {
    process.env.BUILD_TYPE = 'release';
}
// debug, profile, release
const BUILD_TYPE = process.env.BUILD_TYPE || 'release';
const ENGINE_DIR = path.resolve(`node_modules/playcanvas/build/playcanvas${BUILD_TYPE === 'debug' ? '.dbg' : ''}/src/index.js`);
const PCUI_DIR = path.resolve('node_modules/@playcanvas/pcui');
const HREF = process.env.BASE_HREF || '';

const outputHeader = () => {
    const BLUE_OUT = '\x1b[34m';
    const BOLD_OUT = '\x1b[1m';
    const REGULAR_OUT = '\x1b[22m';
    const RESET_OUT = '\x1b[0m';

    const title = [
        'Building ReSplat',
        `type ${BOLD_OUT}${BUILD_TYPE}${REGULAR_OUT}`
    ].map(l => `${BLUE_OUT}${l}`).join('\n');
    console.log(`${BLUE_OUT}${title}${RESET_OUT}\n`);
};

outputHeader();

const application = {
    input: 'src/index.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        copyAndWatch({
            targets: [
                {
                    src: 'src/index.html',
                    transform: (contents, filename) => {
                        return contents.toString().replace('__BASE_HREF__', HREF);
                    }
                },
                { src: 'src/manifest.json' },
                { src: 'static/images', dest: 'static' },
                { src: 'static/icons', dest: 'static' },
                { src: 'static/lib', dest: 'static' },
                { src: 'static/locales', dest: 'static' },
                { src: 'static/luts', dest: 'static' },
                { src: 'static/audio', dest: 'static' },
                { src: 'static/env/VertebraeHDRI_v1_512.png', dest: 'static/env' },
                // splat-transform WebP WASM — needed at runtime for SOG encoding.
                // The JS is bundled into index.js, but the .wasm binary must be
                // fetched separately. configureSplatTransform() in
                // splat-serialize.ts points WebPCodec.wasmUrl at ./webp.wasm.
                { src: 'node_modules/@playcanvas/splat-transform/lib/webp.wasm' },
                // splat-transform worker script — needed for parallel WebP
                // encoding + quantize1d. rollup doesn't rewrite
                // `new Worker(new URL('./worker.mjs', import.meta.url))`, so we
                // copy it to dist/ and configureSplatTransform() sets
                // WorkerQueue.workerUrl to ./worker.mjs.
                // NOTE: source is dist/worker.mjs (lib/ has only webp.wasm).
                { src: 'node_modules/@playcanvas/splat-transform/dist/worker.mjs' },
                // NanoGS CC BY-NC 4.0 license + attribution + project CC BY 4.0
                // license (incl. third-party notices) — copied into dist/ so the
                // license texts ship with the software (web dist/ and the
                // packaged app asar both include dist/**).
                { src: 'src/nanogs/LICENSE-NANOGS.txt', dest: 'licenses' },
                { src: 'src/nanogs/README.md', dest: 'licenses' },
                { src: 'LICENSE', dest: 'licenses', destFilename: 'LICENSE.txt' }
            ]
        }),
        alias({
            entries: {
                'playcanvas': ENGINE_DIR,
                '@playcanvas/pcui': PCUI_DIR
            }
        }),
        typescript({
            tsconfig: './tsconfig.json'
        }),
        resolve(),
        image({ dom: false }),
        json(),
        scss({
            sourceMap: true,
            runtime: sass,
            processor: (css) => {
                return postcss([autoprefixer])
                .process(css, { from: undefined })
                .then(result => result.css);
            },
            fileName: 'index.css',
            includePaths: [`${PCUI_DIR}/dist`],
            watch: 'src/ui/scss'
        }),
        BUILD_TYPE === 'release' &&
        strip({
            include: ['**/*.ts'],
            functions: ['Debug.exec']
        }),
        BUILD_TYPE !== 'debug' && terser()
    ],
    treeshake: 'smallest',
    cache: false
};

const serviceWorker = {
    input: 'src/sw.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    plugins: [
        resolve(),
        json(),
        typescript()
        // BUILD_TYPE !== 'debug' && terser()
    ],
    treeshake: 'smallest',
    cache: false
};

// NanoGS TypeScript port — bundled as a standalone ESM module so the backend
// LCC2 worker (server/lcc2-export-worker.mjs, run directly by Node without TS
// compilation) can import it. The browser path consumes the same TS source
// via src/splat-serialize.ts (bundled into index.js). The module is
// self-contained (typed arrays + Math only), so no resolve()/external deps.
// Licensed CC BY-NC 4.0 — see src/nanogs/README.md.
const nanogs = {
    input: 'src/nanogs/index.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true,
        entryFileNames: 'nanogs.mjs',
        // CC BY-NC 4.0 requires attribution to ship with the adapted material.
        // banner is injected before terser runs, so use a `/*!` legal comment
        // that terser preserves (plain // comments would be stripped).
        banner: [
            '/*!',
            ' * NanoGS TypeScript port - Adapted Material',
            ' * Original: NanoGS (https://github.com/RongLiu-Leo/NanoGS), CC BY-NC 4.0',
            ' * Creators: Butian Xiong, Rong Liu, Tiantian Zhou, Meida Chen, Zhiwen Fan, Andrew Feng',
            ' * License: CC BY-NC 4.0 - https://creativecommons.org/licenses/by-nc/4.0/',
            ' * Modified (Python -> TypeScript port + multi-LOD extension). NOT under the project CC BY 4.0 license.',
            ' * Full text: licenses/LICENSE-NANOGS.txt | Attribution details: licenses/README.md',
            ' */'
        ].join('\n')
    },
    plugins: [
        typescript({
            tsconfig: './tsconfig.json'
        }),
        BUILD_TYPE !== 'debug' && terser()
    ],
    treeshake: 'smallest',
    cache: false
};

export default [
    application,
    serviceWorker,
    nanogs
];
