import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {URI,Utils} from 'vscode-uri';

const bundle=await build({entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false});

// Use VS Code's URI implementation: parsing a bare relative path defaults
// to file: and prepends '/', unlike a generic URL or a simplified URI mock.
const Uri={parse:URI.parse,joinPath:Utils.joinPath};
const uri=(scheme,path,authority='',query='',fragment='')=>URI.from({scheme,path,authority,query,fragment});

for(const scheme of ['file','vscode-remote']){
test(`${scheme}: host resolves image paths against the document and enables webview image resources`,async()=>{
 let provider,onMessage;
 const messages=[];
 const source='# Title\n\n![Board](figures/sim_patterns_board.png)\n\n![Space](<figures/мой график.png>)\n\n![Encoded](./figures/my%20plot.png?version=2#view)\n\n![Absolute](/project/shared/plot.png)\n\n![Parent](../shared/plot.svg#view)\n\n![Remote](https://images.example/plot.png)\n\n![Unsafe](command:run)\n\n![Ref][plot]\n\n[plot]: figures/ref.png';
 const document={uri:uri(scheme,'/project/rnd/12 Антенны ESP32-C3/MAIN.md',scheme==='file'?'':'ssh-remote+host'),version:1,lineCount:20,getText:()=>source};
 const web={
  cspSource:'https://*.vscode-cdn.net',
  asWebviewUri:uri=>URI.from({scheme:'https',path:uri.path,authority:`${uri.scheme}.vscode-cdn.net`,query:uri.query,fragment:uri.fragment}),
  postMessage:async message=>{messages.push(message);return true;},
  onDidReceiveMessage:callback=>{onMessage=callback;return {dispose(){}};},
 };
 const vscode={
  Uri,
  window:{registerCustomEditorProvider:(_id,value)=>{provider=value;return {dispose(){}};}},
  workspace:{workspaceFolders:[{uri:uri(scheme,'/project',scheme==='file'?'':'ssh-remote+host')}],onDidChangeTextDocument:()=>({dispose(){}}),onDidChangeConfiguration:()=>({dispose(){}}),getConfiguration:()=>({get:name=>name==='fontFamily'?"'Fira Code', monospace":14})},
 };
 const module={exports:{}};
 const require=createRequire(import.meta.url);
 new Function('require','module','exports',bundle.outputFiles[0].text)(name=>name==='vscode'?vscode:require(name),module,module.exports);
 module.exports.activate({subscriptions:[],extensionUri:uri('file','/extension')});
 await provider.resolveCustomTextEditor(document,{webview:web,onDidDispose(){}});
 onMessage({type:'ready'});
 const sources=messages[0].imageSources;
 const base=`https://${scheme}.vscode-cdn.net/project/rnd/12%20%D0%90%D0%BD%D1%82%D0%B5%D0%BD%D0%BD%D1%8B%20ESP32-C3`;
 expect(sources['figures/sim_patterns_board.png']).toBe(`${base}/figures/sim_patterns_board.png`);
 expect(sources['figures/мой график.png']).toBe(`${base}/figures/%D0%BC%D0%BE%D0%B9%20%D0%B3%D1%80%D0%B0%D1%84%D0%B8%D0%BA.png`);
 expect(sources['../shared/plot.svg#view']).toBe(`https://${scheme}.vscode-cdn.net/project/rnd/shared/plot.svg#view`);
 expect(sources['figures/ref.png']).toBe(`${base}/figures/ref.png`);
 expect(sources['./figures/my%20plot.png?version=2#view']).toBe(`${base}/figures/my%20plot.png?version%3D2#view`);
 expect(sources['/project/shared/plot.png']).toBe(`https://${scheme}.vscode-cdn.net/project/shared/plot.png`);
 expect(sources['https://images.example/plot.png']).toBe('https://images.example/plot.png');
 expect(sources['command:run']).toBeUndefined();
 expect(web.options.localResourceRoots.map(uri=>uri.path)).toEqual(['/extension/dist','/project/rnd/12 Антенны ESP32-C3','/project']);
 expect(web.html).toContain('img-src https://*.vscode-cdn.net https: http: data:;');
 expect(web.html).toContain(`--rmd-font-size:14px;--rmd-font-family:'Fira Code', monospace`);
 expect(messages[0].text).toBe(source);
});
}
