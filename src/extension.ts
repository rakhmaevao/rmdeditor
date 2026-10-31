import * as vscode from 'vscode';
import * as path from 'node:path';
import {randomBytes} from 'node:crypto';
import {marked} from 'marked';
export function activate(context: vscode.ExtensionContext) {
 context.subscriptions.push(vscode.window.registerCustomEditorProvider('rmdeditor.live', {
  async resolveCustomTextEditor(document, panel) {
   const web = panel.webview;
   const documentDirectory=vscode.Uri.joinPath(document.uri,'..');
   web.options = {enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'dist'),documentDirectory,...(vscode.workspace.workspaceFolders??[]).map(folder=>folder.uri)]};
   const nonce = randomBytes(18).toString('hex');
   const script = web.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'dist/editor.js'));
   const fontConfiguration=()=>{const config=vscode.workspace.getConfiguration('editor');return{fontFamily:String(config.get('fontFamily')||''),fontSize:Number(config.get('fontSize')||14)};};
   const attribute=(value:string)=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
   const fontVars=(font:{fontFamily:string,fontSize:number})=>`--rmd-font-size:${font.fontSize}px${font.fontFamily?`;--rmd-font-family:${attribute(font.fontFamily)}`:''}`;
   web.html = `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src ${web.cspSource} https: http: data:; font-src ${web.cspSource};"></head><body style="${fontVars(fontConfiguration())}"><div id="editor"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
   let applying = false;
   const imageSources=(text:string)=>{
    const sources:Record<string,string>=Object.create(null);
    marked.walkTokens(marked.lexer(text),token=>{
     if(token.type!=='image')return;
     const href=token.href;
     if(/^(https?:|data:image\/)/i.test(href)){sources[href]=href;return;}
     if(/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))return;
     try {
      // A bare relative URI defaults to file: in VS Code and gains a leading
      // slash. Use a neutral scheme so relative paths remain relative.
      const relative=vscode.Uri.parse(`markdown-image:${href}`);
      const file=relative.path.startsWith('/')?documentDirectory.with({path:relative.path}):vscode.Uri.joinPath(documentDirectory,relative.path);
      const target=file.with({query:relative.query,fragment:relative.fragment});
      sources[href]=web.asWebviewUri(target).toString();
     }catch{/* Keep malformed paths visible as an unavailable image. */}
    });
    return sources;
   };
   const send = () => {
    const text=document.getText();
    return web.postMessage({type:'document',text,version:document.version,imageSources:imageSources(text)});
   };
   let queue = Promise.resolve();
   const messages = web.onDidReceiveMessage(message => {
    if(message.type === 'ready') { void send(); return; }
    if(message.type === 'openLink' && typeof message.href === 'string') {
     const href=message.href;
     void (async()=>{
      if(/^(https?:|mailto:)/i.test(href)){await vscode.env.openExternal(vscode.Uri.parse(href));return;}
      if(/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))return;
      const [file,fragment]=href.split('#');
      const target=file?vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath),decodeURIComponent(file))):document.uri;
      const opened=await vscode.workspace.openTextDocument(target);
      const editor=await vscode.window.showTextDocument(opened);
      if(fragment){
       const slug=(s:string)=>s.toLowerCase().trim().replace(/[^\p{L}\p{N}_\s-]/gu,'').replace(/\s+/g,'-');
       const wanted=decodeURIComponent(fragment);
       for(let i=0;i<opened.lineCount;i++){
        const heading=/^#{1,6}\s+(.+?)\s*#*\s*$/.exec(opened.lineAt(i).text);
        if(heading && slug(heading[1])===wanted){editor.selection=new vscode.Selection(i,0,i,0);editor.revealRange(new vscode.Range(i,0,i,0));break;}
       }
      }
     })().catch(error=>void vscode.window.showErrorMessage(`Не удалось открыть ссылку: ${error}`));
     return;
    }
    if(message.type !== 'edit' || typeof message.text !== 'string') return;
    queue = queue.then(async () => {
     if(message.version !== document.version) { await send(); return; }
     const edit = new vscode.WorkspaceEdit();
     edit.replace(document.uri,new vscode.Range(0,0,document.lineCount,0),message.text);
     applying = true;
     try { await vscode.workspace.applyEdit(edit); } finally { applying = false; }
     await web.postMessage({type:'ack',version:document.version,imageSources:imageSources(document.getText())});
    }).catch(error => { void vscode.window.showErrorMessage(String(error)); void send(); });
   });
   const changes = vscode.workspace.onDidChangeTextDocument(e => {if(e.document.uri.toString()===document.uri.toString() && !applying) void send();});
   const fonts = vscode.workspace.onDidChangeConfiguration(e=>{
    if(!e.affectsConfiguration('editor.fontFamily') && !e.affectsConfiguration('editor.fontSize'))return;
    void web.postMessage({type:'font',...fontConfiguration()});
   });
   panel.onDidDispose(() => {messages.dispose();changes.dispose();fonts.dispose();});
  }
 },{supportsMultipleEditorsPerDocument:false}));
}
