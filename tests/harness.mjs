import {build} from 'esbuild';
import {expect} from '@playwright/test';

// Run the actual webview with a VS Code message bridge and access to its view.
const bundle=await build({
 stdin:{contents:`
  import './webview/editor.ts';
  import {EditorView} from '@codemirror/view';
  import {syntaxTree} from '@codemirror/language';
  window.EditorView=EditorView;
  window.editorView=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'));
  window.previewState=()=>{
   const view=window.editorView(),decorations=[];
   for(const set of view.state.facet(EditorView.decorations)) {
    if(typeof set!=='function') set.between(0,view.state.doc.length,(from,to,value)=>{
     const w=value.spec.widget;
     decorations.push({from,to,class:value.spec.class,diagram:typeof w?.code==='string',table:typeof w?.raw==='string'});
    });
   }
   return {text:view.state.doc.toString(),selection:view.state.selection.main.anchor,parsed:syntaxTree(view.state).length,decorations};
  };
 `,resolveDir:process.cwd()},
 bundle:true,platform:'browser',format:'iife',write:false,
});
const script=bundle.outputFiles[0].text;

export async function openEditor(page,text,imageSources={}){
 await page.setContent('<div id="editor"></div>');
 await page.evaluate(({text,imageSources})=>{
  window.messages=[];
  window.acquireVsCodeApi=()=>({postMessage(message){
   window.messages.push(message);
   if(message.type==='ready') window.postMessage({type:'document',text,version:1,imageSources},'*');
  }});
 },{text,imageSources});
 await page.addScriptTag({content:script});
 await expect(page.locator('.cm-editor')).toHaveCount(1);
}
