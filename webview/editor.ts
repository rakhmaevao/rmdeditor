import {EditorState, StateEffect, StateField} from '@codemirror/state';
import {EditorView, Decoration, DecorationSet, WidgetType, keymap, lineNumbers} from '@codemirror/view';
import {markdown} from '@codemirror/lang-markdown';
import {syntaxTree} from '@codemirror/language';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import mermaid from 'mermaid';
import {GFM} from '@lezer/markdown';
import {marked, Tokens} from 'marked';
import hljs from 'highlight.js';
declare function acquireVsCodeApi(): {postMessage(value:unknown):void};
const api=acquireVsCodeApi();
mermaid.initialize({startOnLoad:false,suppressErrorRendering:true,securityLevel:'strict',theme:'base',themeVariables:{background:'#ffffff',primaryColor:'#eceff4',primaryTextColor:'#434c5e',primaryBorderColor:'#88c0d0',lineColor:'#81a1c1',secondaryColor:'#e5e9f0',tertiaryColor:'#d8dee9',fontFamily:'sans-serif'}});
let serial=0;
class Diagram extends WidgetType {
 constructor(readonly code:string,readonly pos:number){super();}
 eq(other:Diagram){return other.code===this.code && other.pos===this.pos;}
 toDOM(view:EditorView){
  const el=document.createElement('div');el.className='diagram';el.textContent='Рисуем Mermaid…';el.title='Нажмите, чтобы редактировать Mermaid';
  el.onclick=()=>{view.dispatch({selection:{anchor:this.pos}});view.focus();};
  void mermaid.render(`diagram-${serial++}`,this.code).then(({svg})=>{el.innerHTML=svg;view.requestMeasure();}).catch(()=>{el.textContent='Ошибка Mermaid — нажмите, чтобы исправить код';view.requestMeasure();});
  return el;
 }
 ignoreEvent(){return true;}
}
class MarkdownBlock extends WidgetType {
 constructor(readonly raw:string,readonly pos:number,readonly kind:'table'|'code'){super();}
 eq(other:MarkdownBlock){return this.raw===other.raw && this.pos===other.pos && this.kind===other.kind;}
 toDOM(view:EditorView){
  const box=document.createElement('div');box.className='rendered-block';
  const edit=document.createElement('button');edit.textContent='Редактировать';
  edit.onclick=e=>{e.stopPropagation();view.dispatch({selection:{anchor:this.pos}});view.focus();};
  box.append(edit);
  const token=marked.lexer(this.raw)[0];
  if(this.kind==='table' && token?.type==='table'){
   box.onclick=()=>{view.dispatch({selection:{anchor:this.pos}});view.focus();};
   const data=token as Tokens.Table;
   const table=document.createElement('table');
   const head=document.createElement('thead'),body=document.createElement('tbody');
   const row=(cells:Tokens.TableCell[],header:boolean)=>{
    const tr=document.createElement('tr');
    cells.forEach((cell,index)=>{const td=document.createElement(header?'th':'td');td.textContent=cell.text;td.style.textAlign=data.align[index]||'left';tr.append(td);});return tr;
   };
   head.append(row(data.header,true));data.rows.forEach(cells=>body.append(row(cells,false)));table.append(head,body);box.append(table);
  }else{
   box.classList.add('code-box');
   const label=document.createElement('div');label.className='code-language';
   label.textContent=token?.type==='code'?(token.lang||''):'';
   const pre=document.createElement('pre'),code=document.createElement('code');
   const source=token?.type==='code'?token.text:this.raw;
   const language=token?.type==='code'?(token.lang||'').trim().split(/\s+/)[0].toLowerCase():'';
   code.className='syntax-code';
   if(language && hljs.getLanguage(language)){
    code.innerHTML=hljs.highlight(source,{language,ignoreIllegals:true}).value;
   }else code.textContent=source;
   pre.append(code);box.append(label,pre);
   // A click on the rendered block must resolve to the source line under the
   // pointer; otherwise the browser caret inside the widget maps past the block.
   box.onclick=(event:MouseEvent)=>{
    const first=view.state.doc.lineAt(this.pos);
    let number=first.number+1;
    if(event.target instanceof Node && pre.contains(event.target)){
     const rect=pre.getBoundingClientRect();
     const lines=source.split('\n').length;
     const index=Math.max(0,Math.min(lines-1,Math.floor((event.clientY-rect.top)/Math.max(rect.height,1)*lines)));
     number=first.number+1+index;
    }
    if(number<=view.state.doc.lines)view.dispatch({selection:{anchor:view.state.doc.line(number).from}});
    view.focus();
   };
  }
  return box;
 }
 ignoreEvent(){return true;}
}
class LinkWidget extends WidgetType {
 constructor(readonly label:string,readonly href:string){super();}
 eq(other:LinkWidget){return this.label===other.label && this.href===other.href;}
 toDOM(){const a=document.createElement('a');a.textContent=this.label;a.href=this.href;a.title=this.href;
 a.onclick=e=>{e.preventDefault();api.postMessage({type:'openLink',href:this.href});};return a;}
 ignoreEvent(){return true;}
}
class SoftBreak extends WidgetType {
 eq(){return true;}
 toDOM(){const span=document.createElement('span');span.className='soft-break';span.textContent=' ';return span;}
 ignoreEvent(){return false;}
}
let imageSources:Record<string,string>={};
const imagesChanged=StateEffect.define<void>();
class ImageWidget extends WidgetType {
 constructor(readonly alt:string,readonly src:string,readonly title:string,readonly pos:number){super();}
 eq(other:ImageWidget){return this.alt===other.alt && this.src===other.src && this.title===other.title && this.pos===other.pos;}
 toDOM(view:EditorView){
  const box=document.createElement('span');box.className='markdown-image';
  box.title=this.title||'Нажмите, чтобы редактировать изображение';
  const edit=()=>{view.dispatch({selection:{anchor:this.pos}});view.focus();};
  box.onclick=edit;
  const unavailable=()=>{box.classList.add('image-unavailable');box.textContent=`Не удалось загрузить изображение${this.alt?`: ${this.alt}`:''}`;view.requestMeasure();};
  if(this.src){
   const img=document.createElement('img');img.alt=this.alt;
   if(this.title)img.title=this.title;
   img.onload=()=>view.requestMeasure();img.onerror=unavailable;
   img.src=this.src;box.append(img);
  }else unavailable();
  return box;
 }
 ignoreEvent(){return true;}
}
// Maps highlight.js HTML back to text offsets so the same colors can decorate
// the raw source while a code block is being edited.
function highlightSpans(html:string){
 const spans:{from:number,to:number,classes:string[]}[]=[];
 const root=new DOMParser().parseFromString(html,'text/html').body;
 let offset=0;
 const walk=(node:Node)=>{
  if(node.nodeType===3){offset+=node.textContent!.length;return;}
  const classes=node.nodeType===1?(node as Element).getAttribute('class'):null;
  const start=offset;
  node.childNodes.forEach(walk);
  if(classes && offset>start)spans.push({from:start,to:offset,classes:classes.split(/\s+/)});
 };
 walk(root);
 return spans;
}
// Extended autolinks keep trailing punctuation and unbalanced parens out of the href.
function trimUrl(raw:string){
 let url=raw,depth=0;
 for(let i=0;i<url.length;i++){
  if(url[i]==='(')depth++;
  else if(url[i]===')'&&depth===0){url=url.slice(0,i);break;}
  else if(url[i]===')')depth--;
 }
 return url.replace(/[.,;:!?'"]+$/,'');
}
function decorate(state:EditorState):DecorationSet {
 const ranges:ReturnType<Decoration['range']>[]=[];
 const softBreaks:{from:number,to:number}[]=[];
 let images:Map<string,Tokens.Image>|undefined;
 const active=(from:number,to:number)=>state.selection.ranges.some(r=>r.from<=to && r.to>=from);
 syntaxTree(state).iterate({enter(node){
  const {from,to,name}=node;
  if(name==='Paragraph' && !active(from,to)){
   const hardBreaks:{from:number,to:number}[]=[],quoteMarks:{from:number,to:number}[]=[],imageRanges:{from:number,to:number}[]=[];
   node.node.toTree().iterate({enter(child){
    if(child.name==='HardBreak')hardBreaks.push({from:from+child.from,to:from+child.to});
    if(child.name==='QuoteMark')quoteMarks.push({from:from+child.from,to:from+child.to});
    if(child.name==='Image')imageRanges.push({from:from+child.from,to:from+child.to});
   }});
   for(const match of state.doc.sliceString(from,to).matchAll(/[ \t]*\n[ \t]*/g)){
    const start=from+match.index;
    let end=start+match[0].length;
    if([...hardBreaks,...imageRanges].some(b=>b.from<end && b.to>start))continue;
    // Continuation lines inside quotes also contain Markdown quote prefixes.
    for(const mark of quoteMarks){
     if(mark.from===end){
      end=mark.to;
      while(end<to && /[ \t]/.test(state.doc.sliceString(end,end+1)))end++;
     }
    }
    softBreaks.push({from:start,to:end});
    ranges.push(Decoration.replace({widget:new SoftBreak()}).range(start,end));
   }
  }
  if(name==='Link'){
   const token=marked.lexer(state.doc.sliceString(from,to),{gfm:true})[0];
   const link=token?.type==='paragraph'?token.tokens?.find(t=>t.type==='link'):undefined;
   if(link?.type==='link' && !active(state.doc.lineAt(from).from,state.doc.lineAt(to).to)){
    ranges.push(Decoration.replace({widget:new LinkWidget(link.text,link.href)}).range(from,to));return false;
   }
  }
  if(name==='URL' || name==='Autolink'){
   if(!active(state.doc.lineAt(from).from,state.doc.lineAt(to).to)){
    const inner=state.doc.sliceString(from,to);
    const url=trimUrl(name==='Autolink'?inner.slice(1,-1):inner);
    if(url && (name==='Autolink' || /^(https?:\/\/|www\.)/i.test(url))){
     const href=/^https?:/i.test(url)?url:`https://${url}`;
     const end=name==='Autolink'?to:from+url.length;
     ranges.push(Decoration.replace({widget:new LinkWidget(url,href)}).range(from,end));
    }
   }
   return false;
  }
  if(name==='Image'){
   if(!active(state.doc.lineAt(from).from,state.doc.lineAt(to).to)){
    if(!images){
     images=new Map();
     marked.walkTokens(marked.lexer(state.doc.toString()),token=>{if(token.type==='image')images!.set(token.raw,token as Tokens.Image);});
    }
    const token=images.get(state.doc.sliceString(from,to));
    if(token){
     const src=Object.hasOwn(imageSources,token.href)?imageSources[token.href]:'';
     ranges.push(Decoration.replace({widget:new ImageWidget(token.text,src,token.title||'',from)}).range(from,to));
    }
   }
   return false;
  }
  if(name==='Table' && !active(from,to)){
   ranges.push(Decoration.replace({widget:new MarkdownBlock(state.doc.sliceString(from,to),from,'table'),block:true}).range(from,to));return false;
  }
  if(name==='FencedCode' || name==='CodeBlock'){
   const raw=state.doc.sliceString(from,to); const match=raw.match(/^(`{3,}|~{3,})mermaid[^\n]*\n([\s\S]*?)\n\1\s*$/);
   if(!active(from,to)) ranges.push(Decoration.replace({widget:match?new Diagram(match[2],from):new MarkdownBlock(raw,from,'code'),block:true}).range(from,to));
   else{
    const first=state.doc.lineAt(from), last=state.doc.lineAt(to);
    for(let line=first;line.from<=to;){
     const classes=['code-source'];
     if(line.number===first.number)classes.push('code-first');
     if(line.number===last.number)classes.push('code-last');
     ranges.push(Decoration.line({class:classes.join(' ')}).range(line.from));
     if(line.number===state.doc.lines)break;line=state.doc.line(line.number+1);
    }
    const fence=raw.match(/^[`~]{3,}/);
    const language=name==='FencedCode'&&fence?(raw.slice(fence[0].length,raw.indexOf('\n')===-1?raw.length:raw.indexOf('\n'))).trim().split(/\s+/)[0].toLowerCase():'';
    if(language && hljs.getLanguage(language) && last.number-first.number>=2){
     const contentFrom=state.doc.line(first.number+1).from, contentTo=state.doc.line(last.number-1).to;
     const source=state.doc.sliceString(contentFrom,contentTo);
     const spans=highlightSpans(hljs.highlight(source,{language,ignoreIllegals:true}).value);
     for(const span of spans)if(span.to>span.from)ranges.push(Decoration.mark({class:span.classes.join(' ')}).range(contentFrom+span.from,contentFrom+span.to));
    }
   }
   return false;
  }
  const heading=/^ATXHeading([1-6])$/.exec(name);
  if(heading) ranges.push(Decoration.line({class:`h${heading[1]}`}).range(state.doc.lineAt(from).from));
  const classes:Record<string,string>={StrongEmphasis:'strong',Emphasis:'em',InlineCode:'code',Link:'link',Blockquote:'quote',Strikethrough:'strike'};
  if(classes[name]) ranges.push(Decoration.mark({class:classes[name]}).range(from,to));
  if(['HeaderMark','EmphasisMark','CodeMark','QuoteMark','StrikethroughMark'].includes(name)){
   if(softBreaks.some(b=>b.from<=from && b.to>=to))return;
   const line=state.doc.lineAt(from);
   if(!active(line.from,line.to)) ranges.push(Decoration.replace({}).range(from,to));
  }
 }});
 return Decoration.set(ranges,true);
}
const live=StateField.define<DecorationSet>({
 create:decorate,
 update(value,tr){
  // Background parsing advances the tree without changing the document or cursor.
  return tr.docChanged||tr.selection||tr.effects.some(effect=>effect.is(imagesChanged))||syntaxTree(tr.startState)!==syntaxTree(tr.state)?decorate(tr.state):value;
 },
 provide:f=>EditorView.decorations.from(f),
});
// Resolve vertical movement in source coordinates before replacement widgets can
// make CodeMirror skip an entire fenced block.
function moveThroughCode(view:EditorView, direction:number, extend=false):boolean {
 const {state}=view, selection=state.selection.main;
 const line=state.doc.lineAt(selection.head), number=line.number+direction;
 if(number<1 || number>state.doc.lines)return false;
 const target=state.doc.line(number);
 let touchesCode=false;
 syntaxTree(state).iterate({from:Math.min(line.from,target.from),to:Math.max(line.to,target.to),enter(node){
  if(node.name==='FencedCode' || node.name==='CodeBlock') {touchesCode=true;return false;}
 }});
 if(!touchesCode)return false;
 const head=target.from+Math.min(selection.head-line.from,target.length);
 view.dispatch({selection:{anchor:extend?selection.anchor:head,head},scrollIntoView:true});
 return true;
}
const codeNavigation=keymap.of([
 {key:'ArrowUp',run:view=>moveThroughCode(view,-1),shift:view=>moveThroughCode(view,-1,true)},
 {key:'ArrowDown',run:view=>moveThroughCode(view,1),shift:view=>moveThroughCode(view,1,true)},
]);
let view:EditorView|undefined, version=0, pending=false, sent='', external=false;
function flush(){if(!view||pending)return; const text=view.state.doc.toString();if(text===sent)return;pending=true;sent=text;api.postMessage({type:'edit',text,version});}
window.addEventListener('message',({data})=>{
 if((data.type==='ack'||data.type==='document') && data.imageSources){
  imageSources=data.imageSources;
  if(view)view.dispatch({effects:imagesChanged.of()});
 }
 if(data.type==='font'){
  if(data.fontFamily)document.body.style.setProperty('--rmd-font-family',String(data.fontFamily));
  if(data.fontSize)document.body.style.setProperty('--rmd-font-size',`${data.fontSize}px`);
  return;
 }
 if(data.type==='ack'){version=data.version;pending=false;flush();return;}
 if(data.type!=='document')return;
 version=data.version;pending=false;sent=data.text;external=true;
 if(view){if(view.state.doc.toString()!==data.text)view.dispatch({changes:{from:0,to:view.state.doc.length,insert:data.text}});}
   else view=new EditorView({parent:document.querySelector('#editor')!,state:EditorState.create({doc:data.text,extensions:[markdown({extensions:[GFM]}),history(),lineNumbers(),codeNavigation,keymap.of([...defaultKeymap,...historyKeymap]),EditorView.lineWrapping,live,EditorView.updateListener.of(u=>{if(u.docChanged&&!external)flush();})]})});
 external=false;
});
const css=document.createElement('style');css.textContent=`
.markdown-image{display:inline-block;max-width:100%;vertical-align:middle;cursor:pointer;line-height:0}.markdown-image img{display:block;max-width:100%;height:auto}.image-unavailable{line-height:1.65;color:#bf616a;background:#eceff4;padding:8px 12px;border-radius:4px;box-sizing:border-box;overflow-wrap:anywhere}
.rendered-block pre code.syntax-code{display:block;background:transparent!important;color:#434c5e;padding:0;border:0;border-radius:0;box-shadow:none;font:inherit;text-shadow:none}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#b48ead}
.hljs-string,.hljs-regexp,.hljs-addition{color:#a3be8c}
.hljs-number,.hljs-symbol,.hljs-bullet{color:#d08770}
.hljs-title,.hljs-section{color:#81a1c1}
.hljs-type,.hljs-built_in,.hljs-attr,.hljs-attribute{color:#8fbcbb}
.hljs-comment,.hljs-quote{color:#7b879b;font-style:italic}
.hljs-meta,.hljs-deletion{color:#bf616a}
.hljs-subst,.hljs-params{color:#434c5e}
.rendered-block{overflow:auto;background:#eceff4;border-radius:6px;padding:24px 12px}.rendered-block.code-box{background:transparent;border:1px solid #d8dee9}.rendered-block button{float:right;border:1px solid #d8dee9;border-radius:4px;background:white;color:#434c5e;cursor:pointer;padding:4px 8px}.rendered-block pre{white-space:pre;overflow:auto;margin:8px 0;font-family:monospace;font-size:0.9em;line-height:1.6;color:#434c5e}.code-language{color:#4c566a;font-size:0.8em;min-height:24px}.code-source{font-family:monospace;font-size:0.9em;background:transparent;border-left:1px solid #d8dee9;border-right:1px solid #d8dee9;padding:0 12px}.code-first{border-top:1px solid #d8dee9;border-radius:6px 6px 0 0;margin-top:8px}.code-last{border-bottom:1px solid #d8dee9;border-radius:0 0 6px 6px;margin-bottom:8px}.rendered-block table{border-collapse:collapse;table-layout:fixed;width:100%;margin-top:36px;background:white}.rendered-block th,.rendered-block td{border:1px solid #d8dee9;padding:8px 12px;white-space:normal;overflow-wrap:anywhere}.rendered-block th{background:#e5e9f0}.rendered-block tr:nth-child(even){background:#f6f8fa}a{color:#d08770;cursor:pointer;text-decoration:underline}
body{color-scheme:light;margin:0;background:#ffffff;color:#434c5e;font-family:var(--rmd-font-family,system-ui,sans-serif);font-size:var(--rmd-font-size,18px);line-height:1.65} .cm-editor{min-height:100vh}.cm-editor.cm-focused{outline:none}.cm-scroller{font-family:inherit!important}.cm-gutters{background:transparent;border-right:none;color:#ccd2dc;font-size:0.85em;padding:0 8px 0 6px}.cm-gutterElement{padding:2px 0}.cm-content{box-sizing:border-box;min-width:0;width:100%;padding:40px 24px 180px!important;caret-color:#434c5e}.cm-line{padding:2px 0}.cm-selectionBackground,::selection{background:rgba(191,97,106,0.6)!important}.cm-cursor{border-left-color:#434c5e!important}
.h1{font-size:1.5em;color:#bf616a}.h2{font-size:1.4em;color:#ebcb8b}.h3{font-size:1.3em;color:#a3be8c}.h4{font-size:1.2em;color:#b48ead}.h5{font-size:1.1em;color:#8fbcbb}.h6{font-size:1em;color:#81a1c1}.h1,.h2,.h3,.h4,.h5,.h6{font-weight:650;padding-top:16px!important}.strong{font-weight:700;color:#a3be8c}.em{font-style:italic;color:#a3be8c}.code{background:#eceff4;color:#88c0d0;font-family:monospace}.link{color:#d08770}.quote{color:#434c5e;border-left:3px solid #88c0d0;padding-left:12px}.strike{text-decoration:line-through}/* Block widgets must carry their spacing as padding, not margin: CodeMirror
   measures widget boxes with getBoundingClientRect, which ignores margins and
   would shift every click below the widget to lower lines. */
.diagram{cursor:pointer;text-align:center;padding:36px 24px;background:#eceff4;border-radius:8px}.diagram svg{max-width:100%;height:auto}
`;document.head.append(css);api.postMessage({type:'ready'});
