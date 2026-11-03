import {EditorState, StateEffect, StateField, Text} from '@codemirror/state';
import {EditorView, Decoration, DecorationSet, ViewUpdate, WidgetType, keymap, lineNumbers} from '@codemirror/view';
import {markdown} from '@codemirror/lang-markdown';
import {syntaxTree} from '@codemirror/language';
import {defaultKeymap, history, historyKeymap} from '@codemirror/commands';
import {SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, highlightSelectionMatches, openSearchPanel, replaceAll, replaceNext, search, searchKeymap, selectMatches, setSearchQuery} from '@codemirror/search';
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
 constructor(readonly raw:string,readonly pos:number){super();}
 eq(other:MarkdownBlock){return this.raw===other.raw && this.pos===other.pos;}
 toDOM(view:EditorView){
  const box=document.createElement('div');box.className='rendered-block';
  const edit=document.createElement('button');edit.textContent='Редактировать';
  edit.onclick=e=>{e.stopPropagation();view.dispatch({selection:{anchor:this.pos}});view.focus();};
  box.append(edit);
  box.onclick=()=>{view.dispatch({selection:{anchor:this.pos}});view.focus();};
  const data=marked.lexer(this.raw)[0] as Tokens.Table;
  const table=document.createElement('table');
  const head=document.createElement('thead'),body=document.createElement('tbody');
  const row=(cells:Tokens.TableCell[],header:boolean)=>{
   const tr=document.createElement('tr');
   cells.forEach((cell,index)=>{const td=document.createElement(header?'th':'td');td.textContent=cell.text;td.style.textAlign=data.align[index]||'left';tr.append(td);});return tr;
  };
  head.append(row(data.header,true));data.rows.forEach(cells=>body.append(row(cells,false)));table.append(head,body);box.append(table);
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
 // The parser discards whitespace before its implied <head>, so a block whose
 // content starts with a blank line would lose that newline and shift every
 // span left. A sentinel character keeps it; the walk starts at -1 to skip it.
 const root=new DOMParser().parseFromString('x'+html,'text/html').body;
 let offset=-1;
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
// TODO highlighting, ported from the obsidian-todo plugin: a paragraph whose
// first line starts with a keyword gets a colored band over all its lines,
// while a keyword inside a paragraph highlights from the marker to the end of
// its sentence — the first `.` (kept) or `)` (dropped), whichever comes first.
interface TodoRule{id:string,keyword:string,bg:string,fg:string}
const todoRules=([
 {id:'todo',keyword:'TODO:',bg:'#ffbd2a',fg:'#ffffff'},
 {id:'tudu',keyword:'ТУДУ:',bg:'#ffbd2a',fg:'#ffffff'},
 {id:'fixme',keyword:'FIXME:',bg:'#f06292',fg:'#ffffff'},
] as TodoRule[]).sort((a,b)=>b.keyword.length-a.keyword.length);
// Headings, quotes, lists, fences and thematic breaks end a paragraph; the
// scanner walks frontmatter and fenced code without highlighting them.
function isTodoBoundary(line:string){
 const trimmed=line.trimStart();
 return !trimmed||/^#{1,6}\s/.test(trimmed)||/^>/.test(trimmed)||/^[-*+]\s+\[[ xX]\]\s+/.test(trimmed)||/^[-*+]\s+/.test(trimmed)||/^\d+[.)]\s+/.test(trimmed)||/^(`{3,}|~{3,})/.test(trimmed)||/^---\s*$/.test(trimmed)||/^\*\*\*\s*$/.test(trimmed)||/^___\s*$/.test(trimmed);
}
function todoSentenceEnd(text:string,from:number,scanFrom:number){
 let end=text.length;
 for(let i=scanFrom;i<text.length;i++){
  if(text[i]==='.'){end=i+1;break;}
  if(text[i]===')'){end=i;break;}
 }
 while(end>from&&/\s/.test(text[end-1]))end--;
 return end;
}
function todoInlineMatches(text:string){
 const found:{from:number,to:number,rule:TodoRule}[]=[];
 for(const rule of todoRules){
  let searchFrom=0;
  for(;;){
   const index=text.indexOf(rule.keyword,searchFrom);
   if(index===-1)break;
   const end=todoSentenceEnd(text,index,index+rule.keyword.length);
   found.push({from:index,to:end,rule});
   searchFrom=Math.max(end,index+rule.keyword.length);
  }
 }
 const matches:typeof found=[];let lastEnd=-1;
 for(const match of [...found].sort((a,b)=>a.from-b.from||b.to-b.from-(a.to-a.from))){
  if(match.from>=lastEnd&&match.to>match.from){matches.push(match);lastEnd=match.to;}
 }
 return matches;
}
// YAML frontmatter opens with `---` on line 1 and closes with a `---`/`...`
// line; scanTodo skips the same block, and so must hr rendering.
function frontmatterEnd(doc:Text){
 if(doc.line(1).text.trim()!=='---')return 0;
 for(let line=2;line<=doc.lines;line++){
  const trimmed=doc.line(line).text.trim();
  if(trimmed==='---'||trimmed==='...')return doc.line(line).to;
 }
 return doc.length;
}
function scanTodo(doc:Text){
 const paragraphs:{lineNumbers:number[],rule:TodoRule}[]=[],inline:{from:number,to:number,rule:TodoRule}[]=[];
 const pushInline=(ln:number)=>{const docLine=doc.line(ln);for(const m of todoInlineMatches(docLine.text))inline.push({from:docLine.from+m.from,to:docLine.from+m.to,rule:m.rule});};
 let lineNumber=1,inFrontmatter=doc.line(1).text.trim()==='---',fence:{char:string,length:number}|null=null;
 while(lineNumber<=doc.lines){
  const line=doc.line(lineNumber).text,trimmed=line.trim();
  if(inFrontmatter){if(lineNumber>1&&(trimmed==='---'||trimmed==='...'))inFrontmatter=false;lineNumber++;continue;}
  if(fence){
   const escaped=fence.char==='`'?'\\`':'~';
   if(new RegExp(`^${escaped}{${fence.length},}\\s*$`).test(trimmed))fence=null;
   lineNumber++;continue;
  }
  const opening=/^(`{3,}|~{3,})/.exec(trimmed);
  if(opening){fence={char:opening[1][0],length:opening[1].length};lineNumber++;continue;}
  if(!trimmed){lineNumber++;continue;}
  // Headings, quotes, lists and thematic breaks never form highlighted
  // paragraphs, but their lines still get inline markers.
  if(isTodoBoundary(line)){pushInline(lineNumber);lineNumber++;continue;}
  const lines=[lineNumber];
  let cursor=lineNumber+1;
  while(cursor<=doc.lines){
   const current=doc.line(cursor).text,currentTrimmed=current.trim();
   if(!currentTrimmed||isTodoBoundary(current)||/^(`{3,}|~{3,})/.test(currentTrimmed))break;
   lines.push(cursor);cursor++;
  }
  const rule=todoRules.find(r=>line.startsWith(r.keyword));
  if(rule)paragraphs.push({lineNumbers:lines,rule});
  else for(const ln of lines)pushInline(ln);
  lineNumber=cursor;
 }
 return{paragraphs,inline};
}
function decorate(state:EditorState):DecorationSet {
 const ranges:ReturnType<Decoration['range']>[]=[];
 let images:Map<string,Tokens.Image>|undefined;
 const frontmatter=frontmatterEnd(state.doc);
 const active=(from:number,to:number)=>state.selection.ranges.some(r=>r.from<=to && r.to>=from);
 syntaxTree(state).iterate({enter(node){
  const {from,to,name}=node;
  // Single newlines stay visible line breaks (Obsidian-style): paragraph lines
  // are never joined into one visual line.
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
   ranges.push(Decoration.replace({widget:new MarkdownBlock(state.doc.sliceString(from,to),from),block:true}).range(from,to));return false;
  }
  if(name==='FencedCode' || name==='CodeBlock'){
   const raw=state.doc.sliceString(from,to);
   const match=raw.match(/^(`{3,}|~{3,})mermaid[^\n]*\n([\s\S]*?)\n\1\s*$/);
   if(match && !active(from,to)){
    ranges.push(Decoration.replace({widget:new Diagram(match[2],from),block:true}).range(from,to));
    return false;
   }
   // Blocks without a renderer stay as source: line numbers and fences stay
   // visible, highlight.js colors the content lines.
   const first=state.doc.lineAt(from), last=state.doc.lineAt(to);
   for(let line=first;line.from<=to;){
    ranges.push(Decoration.line({class:'code-source'}).range(line.from));
    if(line.number===state.doc.lines)break;line=state.doc.line(line.number+1);
   }
   if(name==='FencedCode'){
    ranges.push(Decoration.mark({class:'code-fence'}).range(first.from,first.to));
    if(last.number>first.number && /^(`{3,}|~{3,})\s*$/.test(last.text))ranges.push(Decoration.mark({class:'code-fence'}).range(last.from,last.to));
   }
   const fence=raw.match(/^[`~]{3,}/);
   const language=name==='FencedCode'&&fence?(raw.slice(fence[0].length,raw.indexOf('\n')===-1?raw.length:raw.indexOf('\n'))).trim().split(/\s+/)[0].toLowerCase():'';
   if(language && hljs.getLanguage(language) && last.number-first.number>=2){
    const contentFrom=state.doc.line(first.number+1).from, contentTo=state.doc.line(last.number-1).to;
    const source=state.doc.sliceString(contentFrom,contentTo);
    const spans=highlightSpans(hljs.highlight(source,{language,ignoreIllegals:true}).value);
    for(const span of spans)if(span.to>span.from)ranges.push(Decoration.mark({class:span.classes.join(' ')}).range(contentFrom+span.from,contentFrom+span.to));
   }
   return false;
  }
  if(name==='HorizontalRule'){
   // The line draws as a rule until the cursor enters it; frontmatter
   // delimiters are document structure, not a rule to render.
   const line=state.doc.lineAt(from);
   if(!active(line.from,line.to) && from>=frontmatter){
    ranges.push(Decoration.line({class:'markdown-hr'}).range(line.from));
    ranges.push(Decoration.replace({}).range(from,to));
   }
   return false;
  }
  const heading=/^ATXHeading([1-6])$/.exec(name);
  if(heading) ranges.push(Decoration.line({class:`h${heading[1]}`}).range(state.doc.lineAt(from).from));
  const classes:Record<string,string>={StrongEmphasis:'strong',Emphasis:'em',InlineCode:'code',Link:'link',Blockquote:'quote',Strikethrough:'strike'};
  if(classes[name]) ranges.push(Decoration.mark({class:classes[name]}).range(from,to));
  if(['HeaderMark','EmphasisMark','CodeMark','QuoteMark','StrikethroughMark'].includes(name)){
   const line=state.doc.lineAt(from);
   // The separator between ATX marks and the title belongs to no syntax node,
   // so the hiding range has to swallow it explicitly (setext underlines end
   // at the line end and must not grow).
   let end=to;
   if(name==='HeaderMark' && /^ATXHeading/.test(node.node.parent?.name||''))while(end<line.to && /[ \t]/.test(state.doc.sliceString(end,end+1)))end++;
   if(!active(line.from,line.to)) ranges.push(Decoration.replace({}).range(from,end));
  }
 }});
 const todo=scanTodo(state.doc);
 for(const match of todo.paragraphs){
  // Every paragraph line renders as its own visual line, so the band is a
  // per-line decoration: the first line rounds the top, the last the bottom.
  match.lineNumbers.forEach((lineNumber,i)=>{
   const classes=['todo-paragraph-highlight','todo-rule-'+match.rule.id];
   if(i===0)classes.push('todo-paragraph-start');
   if(i===match.lineNumbers.length-1)classes.push('todo-paragraph-end');
   ranges.push(Decoration.line({class:classes.join(' ')}).range(state.doc.line(lineNumber).from));
  });
 }
 for(const m of todo.inline)ranges.push(Decoration.mark({class:`todo-paragraph-highlight todo-paragraph-inline todo-rule-${m.rule.id}`}).range(m.from,m.to));
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
// Floating find/replace widget styled after the regular editor. The panel
// handles its own keys because CodeMirror keymaps only receive contentDOM
// events, never events from panel inputs.
let replaceShown=false;
function searchPanel(view:EditorView){
 const makeButton=(text:string,title:string,onclick:()=>void)=>{const node=document.createElement('button');node.type='button';node.className='rmd-btn';node.textContent=text;node.title=title;node.onclick=onclick;return node;};
 const find=document.createElement('input'),replace=document.createElement('input');
 for(const[node,placeholder] of [[find,'Найти'],[replace,'Заменить']] as const){node.className='rmd-input';node.placeholder=placeholder;node.spellcheck=false;}
 find.title='Enter — следующее совпадение, Shift+Enter — предыдущее, F3 — повтор поиска';
 find.setAttribute('main-field','true');
 replace.title='Enter — заменить текущее совпадение';
 const initial=getSearchQuery(view.state);
 find.value=initial.search;
 replace.value=initial.replace;
 const toggles:Record<'caseSensitive'|'wholeWord'|'regexp',HTMLButtonElement>={
  caseSensitive:makeButton('Aa','Учитывать регистр',()=>{toggles.caseSensitive.classList.toggle('on');commit(true);}),
  wholeWord:makeButton('ab','Только целые слова',()=>{toggles.wholeWord.classList.toggle('on');commit(true);}),
  regexp:makeButton('.*','Регулярное выражение',()=>{toggles.regexp.classList.toggle('on');commit(true);}),
 };
 for(const key of Object.keys(toggles) as (keyof typeof toggles)[]){
  toggles[key].classList.add('rmd-toggle');
  toggles[key].classList.toggle('on',initial[key]);
 }
 const counter=document.createElement('span');counter.className='rmd-count';
 const buildQuery=()=>new SearchQuery({search:find.value,replace:replace.value,caseSensitive:toggles.caseSensitive.classList.contains('on'),wholeWord:toggles.wholeWord.classList.contains('on'),regexp:toggles.regexp.classList.contains('on')});
 const sync=()=>{
  const query=getSearchQuery(view.state);
  find.classList.toggle('rmd-invalid',!!query.search&&!query.valid);
  // Typing must not be undone by a re-render triggered by the query itself.
  if(document.activeElement!==find&&document.activeElement!==replace){
   if(find.value!==query.search)find.value=query.search;
   if(replace.value!==query.replace)replace.value=query.replace;
  }
  for(const key of Object.keys(toggles) as (keyof typeof toggles)[])toggles[key].classList.toggle('on',query[key]);
  counter.textContent='';
  counter.classList.remove('no-match');
  if(!query.search||!query.valid)return;
  try{
   const head=view.state.selection.main.head;
   const cursor=query.getCursor(view.state.doc);
   let total=0,index=-1,after=-1;
   for(let result=cursor.next();!result.done;result=cursor.next()){
    total++;
    const{from,to}=result.value;
    if(from<=head&&to>=head)index=total;
    else if(index<0&&after<0&&from>=head)after=total;
   }
   if(total){
    if(index<0)index=after>0?after:1;
    counter.textContent=`${index} из ${total}`;
   }else{
    counter.textContent='Нет совпадений';
    counter.classList.add('no-match');
   }
  }catch{/* A regexp that can match the empty string cannot be counted. */}
 };
 const commit=(jump:boolean)=>{
  const query=buildQuery();
  const previous=view.state.selection.main;
  if(!query.eq(getSearchQuery(view.state)))view.dispatch({effects:setSearchQuery.of(query)});
  if(jump&&query.valid){
   // While typing, grow the match at the current spot like the regular
   // editor does; only jump ahead when the old position no longer matches.
   const nearby=query.getCursor(view.state.doc,previous.from,Math.min(view.state.doc.length,previous.from+query.search.length)).next();
   if(!nearby.done)view.dispatch({selection:{anchor:nearby.value.from,head:nearby.value.to},scrollIntoView:true});
   else findNext(view);
  }
  sync();
 };
 find.addEventListener('input',()=>commit(true));
 replace.addEventListener('input',()=>commit(false));
 const replaceRow=document.createElement('div');replaceRow.className='rmd-search-row rmd-replace';
 const replaceWrap=document.createElement('div');replaceWrap.className='rmd-inputwrap';
 replaceWrap.append(replace);
 replaceRow.append(replaceWrap,makeButton('Заменить','Заменить текущее совпадение',()=>replaceNext(view)),makeButton('Заменить всё','Заменить все совпадения',()=>replaceAll(view)));
 const expand=makeButton(replaceShown?'▾':'▸','Показать или скрыть панель замены (Ctrl+H)',()=>{replaceShown=!replaceShown;placeReplace();});
 expand.classList.add('rmd-expand');
 function placeReplace(){replaceRow.style.display=replaceShown?'flex':'none';expand.textContent=replaceShown?'▾':'▸';}
 placeReplace();
 const wrap=document.createElement('div');wrap.className='rmd-inputwrap';
 wrap.append(find,toggles.caseSensitive,toggles.wholeWord,toggles.regexp);
 const row=document.createElement('div');row.className='rmd-search-row';
 row.append(expand,wrap,counter,
  makeButton('↑','Предыдущее совпадение (Shift+Enter)',()=>findPrevious(view)),
  makeButton('↓','Следующее совпадение (Enter)',()=>findNext(view)),
  makeButton('≡','Найти в выделенном',()=>selectMatches(view)),
  makeButton('✕','Закрыть (Escape)',()=>closeSearchPanel(view)));
 const root=document.createElement('div');root.className='rmd-search';
 root.append(row,replaceRow);
 // Buttons must not steal focus from the query inputs.
 root.onmousedown=(event)=>{if(event.target instanceof HTMLButtonElement)event.preventDefault();};
 root.onkeydown=event=>{
  const mod=event.ctrlKey||event.metaKey;
  if(event.key==='Enter'){event.preventDefault();if(event.target===replace)replaceNext(view);else if(event.shiftKey)findPrevious(view);else findNext(view);}
  else if(event.key==='Escape'){event.preventDefault();closeSearchPanel(view);}
  else if(event.key==='F3'){event.preventDefault();event.shiftKey?findPrevious(view):findNext(view);}
  else if(mod&&event.key.toLowerCase()==='g'){event.preventDefault();event.shiftKey?findPrevious(view):findNext(view);}
  else if(mod&&event.key.toLowerCase()==='f'){event.preventDefault();find.focus();find.select();}
  else if(mod&&event.key.toLowerCase()==='h'){event.preventDefault();replaceShown=true;placeReplace();replace.focus();replace.select();}
 };
 sync();
 return{dom:root,top:true,mount(){find.focus();find.select();},update(update:ViewUpdate){
  if(update.docChanged||update.selectionSet||update.transactions.some(transaction=>transaction.effects.some(effect=>effect.is(setSearchQuery))))sync();
 }};
}
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
   else view=new EditorView({parent:document.querySelector('#editor')!,state:EditorState.create({doc:data.text,extensions:[
    markdown({extensions:[GFM]}),
    // Russian labels for the goto-line panel and search announcements.
    EditorState.phrases.of({'Go to line':'Перейти к строке','go':'Перейти','current match':'текущее совпадение','on line':'в строке','no match':'совпадений нет','replaced $ matches':'заменено совпадений: $','replaced match on line $':'заменено совпадение в строке $'}),
    search({top:true,createPanel:searchPanel}),
    highlightSelectionMatches(),
    history(),lineNumbers(),codeNavigation,
    keymap.of([...searchKeymap,{key:'Mod-h',run:v=>{replaceShown=true;return openSearchPanel(v);}},...defaultKeymap,...historyKeymap]),
    EditorView.lineWrapping,live,EditorView.updateListener.of(u=>{if(u.docChanged&&!external)flush();})
   ]})});
 external=false;
});
const css=document.createElement('style');css.textContent=`
.markdown-image{display:inline-block;max-width:100%;vertical-align:middle;cursor:pointer;line-height:0}.markdown-image img{display:block;max-width:100%;height:auto}.image-unavailable{line-height:1.65;color:#bf616a;background:#eceff4;padding:8px 12px;border-radius:4px;box-sizing:border-box;overflow-wrap:anywhere}
.hljs-keyword,.hljs-selector-tag,.hljs-literal{color:#b48ead}
.hljs-string,.hljs-regexp,.hljs-addition{color:#a3be8c}
.hljs-number,.hljs-symbol,.hljs-bullet{color:#d08770}
.hljs-title,.hljs-section{color:#81a1c1}
.hljs-type,.hljs-built_in,.hljs-attr,.hljs-attribute{color:#8fbcbb}
.hljs-comment,.hljs-quote{color:#7b879b;font-style:italic}
.hljs-meta,.hljs-deletion{color:#bf616a}
.hljs-subst,.hljs-params{color:#434c5e}
.rendered-block{overflow:auto;background:#eceff4;border-radius:6px;padding:24px 12px}.rendered-block button{float:right;border:1px solid #d8dee9;border-radius:4px;background:white;color:#434c5e;cursor:pointer;padding:4px 8px}.code-source{font-family:monospace;font-size:0.9em}.code-fence{color:#81a1c1}.rendered-block table{border-collapse:collapse;table-layout:fixed;width:100%;margin-top:36px;background:white}.rendered-block th,.rendered-block td{border:1px solid #d8dee9;padding:8px 12px;white-space:normal;overflow-wrap:anywhere}.rendered-block th{background:#e5e9f0}.rendered-block tr:nth-child(even){background:#f6f8fa}a{color:#d08770;cursor:pointer;text-decoration:underline}
body{color-scheme:light;margin:0;background:#ffffff;color:#434c5e;font-family:var(--rmd-font-family,system-ui,sans-serif);font-size:var(--rmd-font-size,18px);line-height:1.5} .cm-editor{min-height:100vh}.cm-editor.cm-focused{outline:none}.cm-scroller{font-family:inherit!important}/* The id raises specificity above the base theme, whose "&light .cm-gutters"
   rule (background strip, gray border, default color) would otherwise win. */
#editor .cm-gutters{background:transparent;border-right:none;color:#9aa0aa;padding:0 8px 0 6px}.cm-content{box-sizing:border-box;min-width:0;width:100%;padding:40px 24px 180px!important;caret-color:#434c5e}.cm-line{padding:0}.cm-selectionBackground,::selection{background:rgba(191,97,106,0.6)!important}.cm-cursor{border-left-color:#434c5e!important}
.h1{font-size:1.5em;color:#bf616a}.h2{font-size:1.4em;color:#ebcb8b}.h3{font-size:1.3em;color:#a3be8c}.h4{font-size:1.2em;color:#b48ead}.h5{font-size:1.1em;color:#8fbcbb}.h6{font-size:1em;color:#81a1c1}.h1,.h2,.h3,.h4,.h5,.h6{font-weight:650;padding-top:16px!important}.strong{font-weight:700;color:#a3be8c}.em{font-style:italic;color:#a3be8c}.code{background:#eceff4;color:#88c0d0;font-family:monospace}.link{color:#d08770}.quote{color:#434c5e;border-left:3px solid #88c0d0;padding-left:12px}.strike{text-decoration:line-through}/* The hidden source leaves the line empty, so its own box height centers
   the rule between the surrounding paragraphs. */
.markdown-hr{padding:10px 0!important;border-bottom:2px solid #d8dee9}/* Block widgets must carry their spacing as padding, not margin: CodeMirror
   measures widget boxes with getBoundingClientRect, which ignores margins and
   would shift every click below the widget to lower lines. */
.diagram{cursor:pointer;text-align:center;padding:36px 24px;background:#eceff4;border-radius:8px}.diagram svg{max-width:100%;height:auto}
/* Search widget: floats over the content like the regular editor's find bar.
   The workbench UI font is set explicitly so editor.fontFamily does not leak in. */
.cm-panels.cm-panels-top{position:fixed;top:10px;right:22px;left:auto;z-index:30;background:#ffffff;border:1px solid #d8dee9;border-radius:6px;box-shadow:0 6px 24px rgba(46,52,64,.16);padding:6px 8px;color:#434c5e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Ubuntu','Droid Sans','Helvetica Neue',Arial,sans-serif;font-size:13px}
.rmd-search{display:flex;flex-direction:column;gap:6px}
.rmd-search-row{display:flex;align-items:center;gap:4px}
.rmd-inputwrap{display:flex;align-items:center;border:1px solid #d8dee9;border-radius:4px;background:#ffffff;padding:0 2px;height:26px}
.rmd-inputwrap:focus-within{border-color:#88c0d0}
.rmd-inputwrap:has(.rmd-invalid){border-color:#bf616a}
.rmd-input{font:inherit;font-size:13px;width:130px;padding:0 4px;border:0;outline:none;background:transparent;color:#434c5e}
.rmd-replace{gap:6px}
.rmd-replace .rmd-btn{padding:4px 6px}
.rmd-btn{font:inherit;font-size:13px;line-height:1;border:0;border-radius:4px;background:transparent;color:#4c566a;padding:4px 5px;cursor:pointer}
.rmd-btn:hover{background:#e5e9f0;color:#434c5e}
.rmd-toggle{font-size:12px;padding:3px 4px;border-radius:3px}.rmd-toggle.on{background:#88c0d0;color:#ffffff}
.rmd-expand{min-width:22px;padding:4px 2px}
.rmd-count{margin:0 6px;color:#4c566a;font-size:12px;white-space:nowrap}
.rmd-count.no-match{color:#bf616a}
.cm-searchMatch{background:rgba(235,203,139,.45)}
.cm-searchMatch-selected{background:rgba(235,203,139,.8)}
.cm-selectionMatch{background:rgba(136,192,208,.3)}
/* TODO highlight, ported from the obsidian-todo plugin. */
.todo-paragraph-highlight{background-color:var(--todo-paragraph-bg,#ffbd2a);color:var(--todo-paragraph-fg,#ffffff)}
${todoRules.map(r=>`.todo-rule-${r.id}{--todo-paragraph-bg:${r.bg};--todo-paragraph-fg:${r.fg}}`).join('')}
/* Markdown span colors inside a highlighted band inherit the band color. */
.cm-line.todo-paragraph-highlight span{color:inherit}
.cm-line .todo-paragraph-inline{color:var(--todo-paragraph-fg)!important;border-radius:4px;padding:0 .15em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.cm-line.todo-paragraph-highlight.todo-paragraph-start{border-radius:6px 6px 0 0}
.cm-line.todo-paragraph-highlight.todo-paragraph-end{border-radius:0 0 6px 6px}
.cm-line.todo-paragraph-highlight.todo-paragraph-start.todo-paragraph-end{border-radius:6px}
`;document.head.append(css);api.postMessage({type:'ready'});
