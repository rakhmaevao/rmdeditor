import {test,expect} from '@playwright/test';
import {build} from 'esbuild';

// Run the actual webview with a VS Code message bridge and access to its view.
const bundle=await build({
 stdin:{contents:`
  import './webview/editor.ts';
  import {EditorView} from '@codemirror/view';
  import {syntaxTree} from '@codemirror/language';
  window.editorView=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'));
  window.previewState=()=>{
   const view=window.editorView(),decorations=[];
   for(const set of view.state.facet(EditorView.decorations)) {
    if(typeof set!=='function') set.between(0,view.state.doc.length,(from,to,value)=>{
     decorations.push({from,to,class:value.spec.class,kind:value.spec.widget?.kind,diagram:typeof value.spec.widget?.code==='string'});
    });
   }
   return {text:view.state.doc.toString(),selection:view.state.selection.main.anchor,parsed:syntaxTree(view.state).length,decorations};
  };
 `,resolveDir:process.cwd()},
 bundle:true,platform:'browser',format:'iife',write:false,
});
const script=bundle.outputFiles[0].text;
const doc='# Document\n\n'+('A paragraph before the later sections. '.repeat(10)+'\n\n').repeat(12)+`
##### Later heading

###### Deeper heading

~~~mermaid
---
config:
  treemap:
    theme: 'base'
    showValues: false
---
treemap-beta
"Plot"
    "attr"
        "dpi": 1
~~~

~~~julia
p = plot([1, 2], [3, 4])
~~~

| Header | Value |
| ------ | ----- |
| item   | 1     |
`;

async function openEditor(page,text){
 await page.setContent('<div id="editor"></div>');
 await page.evaluate(text=>{
  window.messages=[];
  window.acquireVsCodeApi=()=>({postMessage(message){
   window.messages.push(message);
   if(message.type==='ready') window.postMessage({type:'document',text,version:1},'*');
  }});
 },text);
 await page.addScriptTag({content:script});
 await expect(page.locator('.cm-editor')).toHaveCount(1);
}

async function expectFullPreview(page,text){
 await expect.poll(()=>page.evaluate(()=>window.previewState().parsed)).toBe(text.length);
 await expect.poll(()=>page.evaluate(()=>window.previewState().decorations.map(d=>d.class).filter(Boolean))).toContain('h5');
 const state=await page.evaluate(()=>window.previewState());
 expect(state.text).toBe(text);
 expect(state.selection).toBe(0);
 expect(state.decorations.some(d=>d.class==='h6')).toBe(true);
 expect(state.decorations.some(d=>d.diagram)).toBe(true);
 expect(state.decorations.some(d=>d.kind==='code')).toBe(true);
 expect(state.decorations.some(d=>d.kind==='table')).toBe(true);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
 await page.evaluate(()=>{
  const view=window.editorView();
  // Scroll without moving the cursor or editing the document.
  window.scrollTo(0,document.body.scrollHeight);
  view.requestMeasure();
 });
 await expect(page.locator('.h5')).toHaveText('Later heading');
 await expect(page.locator('.h6')).toHaveText('Deeper heading');
 await expect(page.locator('.diagram svg')).toHaveCount(1);
 await expect(page.locator('.syntax-code')).toContainText('p = plot');
 await expect(page.locator('.rendered-block table')).toContainText('item');
}

test('background parsing renders later headings, Mermaid, code and tables without editing',async({page})=>{
 const backtickDoc=doc.replaceAll('~~~',String.fromCharCode(96).repeat(3));
 await openEditor(page,backtickDoc);
 await expectFullPreview(page,backtickDoc);
});

test('background parsing refreshes the preview after an external document update',async({page})=>{
 await openEditor(page,'# Short document\n');
 await page.evaluate(text=>window.postMessage({type:'document',text,version:2},'*'),doc);
 await expectFullPreview(page,doc);
});
