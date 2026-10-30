import {EditorState, StateField} from '@codemirror/state';
import {EditorView, Decoration, DecorationSet, WidgetType, keymap} from '@codemirror/view';
import {markdown} from '@codemirror/lang-markdown';
import {syntaxTree} from '@codemirror/language';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import mermaid from 'mermaid';
import {GFM} from '@lezer/markdown';
import {marked, Tokens} from 'marked';
import hljs from 'highlight.js/lib/common';
declare function acquireVsCodeApi(): {postMessage(value:unknown):void};
const api=acquireVsCodeApi();
mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',themeVariables:{background:'#ffffff',primaryColor:'#eceff4',primaryTextColor:'#434c5e',primaryBorderColor:'#88c0d0',lineColor:'#81a1c1',secondaryColor:'#e5e9f0',tertiaryColor:'#d8dee9',fontFamily:'sans-serif'}});
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
  edit.onclick=()=>{view.dispatch({selection:{anchor:this.pos}});view.focus();};
  box.append(edit);
  const token=marked.lexer(this.raw)[0];
  if(this.kind==='table' && token?.type==='table'){
   const data=token as Tokens.Table;
   const table=document.createElement('table');
   const head=document.createElement('thead'),body=document.createElement('tbody');
   const row=(cells:Tokens.TableCell[],header:boolean)=>{
    const tr=document.createElement('tr');
    cells.forEach((cell,index)=>{const td=document.createElement(header?'th':'td');td.textContent=cell.text;td.style.textAlign=data.align[index]||'left';tr.append(td);});return tr;
   };
   head.append(row(data.header,true));data.rows.forEach(cells=>body.append(row(cells,false)));table.append(head,body);box.append(table);
  }else{
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
function decorate(state:EditorState):DecorationSet {
 const ranges:ReturnType<Decoration['range']>[]=[];
 const active=(from:number,to:number)=>state.selection.ranges.some(r=>r.from<=to && r.to>=from);
 syntaxTree(state).iterate({enter(node){
  const {from,to,name}=node;
  if(name==='Link'){
   const token=marked.lexer(state.doc.sliceString(from,to),{gfm:true})[0];
   const link=token?.type==='paragraph'?token.tokens?.find(t=>t.type==='link'):undefined;
   if(link?.type==='link' && !active(state.doc.lineAt(from).from,state.doc.lineAt(to).to)){
    ranges.push(Decoration.replace({widget:new LinkWidget(link.text,link.href)}).range(from,to));return false;
   }
  }
  if(name==='Image') return false;
  if(name==='Table' && !active(from,to)){
   ranges.push(Decoration.replace({widget:new MarkdownBlock(state.doc.sliceString(from,to),from,'table'),block:true}).range(from,to));return false;
  }
  if(name==='FencedCode' || name==='CodeBlock'){
   const raw=state.doc.sliceString(from,to); const match=raw.match(/^(`{3,}|~{3,})mermaid[^\n]*\n([\s\S]*?)\n\1\s*$/);
   if(!active(from,to)) ranges.push(Decoration.replace({widget:match?new Diagram(match[2],from):new MarkdownBlock(raw,from,'code'),block:true}).range(from,to));
   else for(let line=state.doc.lineAt(from);line.from<=to;){
    ranges.push(Decoration.line({class:'code-source'}).range(line.from));
    if(line.number===state.doc.lines)break;line=state.doc.line(line.number+1);
   }
   return false;
  }
  const heading=/^ATXHeading([1-6])$/.exec(name);
  if(heading) ranges.push(Decoration.line({class:`h${heading[1]}`}).range(state.doc.lineAt(from).from));
  const classes:Record<string,string>={StrongEmphasis:'strong',Emphasis:'em',InlineCode:'code',Link:'link',Blockquote:'quote',Strikethrough:'strike'};
  if(classes[name]) ranges.push(Decoration.mark({class:classes[name]}).range(from,to));
  if(['HeaderMark','EmphasisMark','CodeMark','QuoteMark','StrikethroughMark'].includes(name)){
   const line=state.doc.lineAt(from);
   if(!active(line.from,line.to)) ranges.push(Decoration.replace({}).range(from,to));
  }
 }});
 return Decoration.set(ranges,true);
}
const live=StateField.define<DecorationSet>({create:decorate,update(value,tr){return tr.docChanged||tr.selection?decorate(tr.state):value;},provide:f=>EditorView.decorations.from(f)});
let view:EditorView|undefined, version=0, pending=false, sent='', external=false;
function flush(){if(!view||pending)return; const text=view.state.doc.toString();if(text===sent)return;pending=true;sent=text;api.postMessage({type:'edit',text,version});}
window.addEventListener('message',({data})=>{
 if(data.type==='ack'){version=data.version;pending=false;flush();return;}
 if(data.type!=='document')return;
 version=data.version;pending=false;sent=data.text;external=true;
 if(view){if(view.state.doc.toString()!==data.text)view.dispatch({changes:{from:0,to:view.state.doc.length,insert:data.text}});}
 else view=new EditorView({parent:document.querySelector('#editor')!,state:EditorState.create({doc:data.text,extensions:[markdown({extensions:[GFM]}),history(),keymap.of([...defaultKeymap,...historyKeymap]),EditorView.lineWrapping,live,EditorView.updateListener.of(u=>{if(u.docChanged&&!external)flush();})]})});
 external=false;
});
const css=document.createElement('style');css.textContent=`
.rendered-block pre code.syntax-code{display:block;background:transparent!important;color:#434c5e;padding:0;border:0;border-radius:0;box-shadow:none;font:inherit;text-shadow:none}
.syntax-code .hljs-keyword,.syntax-code .hljs-selector-tag,.syntax-code .hljs-literal{color:#b48ead}
.syntax-code .hljs-string,.syntax-code .hljs-regexp,.syntax-code .hljs-addition{color:#a3be8c}
.syntax-code .hljs-number,.syntax-code .hljs-symbol,.syntax-code .hljs-bullet{color:#d08770}
.syntax-code .hljs-title,.syntax-code .hljs-section{color:#81a1c1}
.syntax-code .hljs-type,.syntax-code .hljs-built_in,.syntax-code .hljs-attr,.syntax-code .hljs-attribute{color:#8fbcbb}
.syntax-code .hljs-comment,.syntax-code .hljs-quote{color:#7b879b;font-style:italic}
.syntax-code .hljs-meta,.syntax-code .hljs-deletion{color:#bf616a}
.syntax-code .hljs-subst,.syntax-code .hljs-params{color:#434c5e}
.rendered-block{margin:12px 0;overflow:auto;background:#eceff4;border-radius:6px;padding:12px}.rendered-block button{float:right;border:1px solid #d8dee9;border-radius:4px;background:white;color:#434c5e;cursor:pointer;padding:4px 8px}.rendered-block pre{white-space:pre;overflow:auto;margin:8px 0;font:16px/1.6 monospace;color:#434c5e}.code-language{color:#4c566a;font-size:13px;min-height:24px}.code-source{font-family:monospace;background:#eceff4}.rendered-block table{border-collapse:collapse;width:100%;margin-top:36px;background:white}.rendered-block th,.rendered-block td{border:1px solid #d8dee9;padding:8px 12px}.rendered-block th{background:#e5e9f0}.rendered-block tr:nth-child(even){background:#f6f8fa}a{color:#d08770;cursor:pointer;text-decoration:underline}
body{color-scheme:light;margin:0;background:#ffffff;color:#434c5e;font:18px/1.65 system-ui,sans-serif} .cm-editor{min-height:100vh}.cm-editor.cm-focused{outline:none}.cm-scroller{font-family:inherit!important}.cm-content{max-width:850px;width:100%;margin:auto;padding:40px 48px 180px!important;caret-color:#434c5e}.cm-line{padding:2px 0}.cm-selectionBackground,::selection{background:rgba(191,97,106,0.6)!important}.cm-cursor{border-left-color:#434c5e!important}
.h1{font-size:1.5em;color:#bf616a}.h2{font-size:1.4em;color:#ebcb8b}.h3{font-size:1.3em;color:#a3be8c}.h4{font-size:1.2em;color:#b48ead}.h5{font-size:1.1em;color:#8fbcbb}.h6{font-size:1em;color:#81a1c1}.h1,.h2,.h3,.h4,.h5,.h6{font-weight:650;padding-top:16px!important}.strong{font-weight:700;color:#a3be8c}.em{font-style:italic;color:#a3be8c}.code{background:#eceff4;color:#88c0d0;font-family:monospace}.link{color:#d08770}.quote{color:#434c5e;border-left:3px solid #88c0d0;padding-left:12px}.strike{text-decoration:line-through}.diagram{cursor:pointer;text-align:center;padding:24px;background:#eceff4;border-radius:8px;margin:12px 0}.diagram svg{max-width:100%;height:auto}
`;document.head.append(css);api.postMessage({type:'ready'});
