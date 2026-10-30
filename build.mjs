import {build} from 'esbuild';
await build({entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode'],outfile:'dist/extension.js'});
await build({entryPoints:['webview/editor.ts'],bundle:true,platform:'browser',format:'iife',outfile:'dist/editor.js'});
