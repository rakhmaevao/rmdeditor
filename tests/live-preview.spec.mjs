import {test,expect} from '@playwright/test';
import {openEditor} from './harness.mjs';

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

async function expectFullPreview(page,text){
 await expect.poll(()=>page.evaluate(()=>window.previewState().parsed)).toBe(text.length);
 await expect.poll(()=>page.evaluate(()=>window.previewState().decorations.map(d=>d.class).filter(Boolean))).toContain('h5');
 const state=await page.evaluate(()=>window.previewState());
 expect(state.text).toBe(text);
 expect(state.selection).toBe(0);
 expect(state.decorations.some(d=>d.class==='h6')).toBe(true);
 expect(state.decorations.some(d=>d.diagram)).toBe(true);
 expect(state.decorations.some(d=>d.class==='code-source')).toBe(true);
 expect(state.decorations.some(d=>d.table)).toBe(true);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
 await page.evaluate(text=>{
  const view=window.editorView();
  // Scroll without moving the cursor or editing the document: CodeMirror
  // renders only the visible viewport, so bring each checked area into it.
  view.dispatch({effects:window.EditorView.scrollIntoView(text.indexOf('Later heading'),{y:'center'})});
 },text);
 await expect(page.locator('.h5')).toHaveText('Later heading');
 await expect(page.locator('.h6')).toHaveText('Deeper heading');
 await expect(page.locator('.diagram svg')).toHaveCount(1);
 await page.evaluate(text=>{
  const view=window.editorView();
  view.dispatch({effects:window.EditorView.scrollIntoView(text.indexOf('| item'),{y:'center'})});
 },text);
 await expect(page.locator('.cm-line').filter({hasText:'p = plot'})).toBeVisible();
 await expect(page.locator('.rendered-block')).toHaveCount(1);
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

test('arrows enter code blocks and shift selects the adjacent source line',async({page})=>{
 const text='Before\n\n~~~js\nfirst\nsecond\n~~~\n\nAfter';
 await openEditor(page,text);
 await page.evaluate(()=>{const view=window.editorView();view.dispatch({selection:{anchor:7}});view.focus();});
 await page.keyboard.press('ArrowDown');
 expect(await page.evaluate(()=>window.editorView().state.selection.main.head)).toBe(8);
 await page.keyboard.press('ArrowDown');
 expect(await page.evaluate(()=>window.editorView().state.selection.main.head)).toBe(14);
 await page.keyboard.press('Shift+ArrowDown');
 expect(await page.evaluate(()=>{const s=window.editorView().state.selection.main;return {anchor:s.anchor,head:s.head};})).toEqual({anchor:14,head:20});
});

test('ATX heading marks hide together with the separator spaces',async({page})=>{
 const text='#### Контекст\n\n####   Три пробела\n\nBody';
 await openEditor(page,text);
 // The cursor starts on the first heading, so it shows its source; park it on
 // the last line to render both headings.
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:window.editorView().state.doc.length}}));
 await expect(page.locator('.h4')).toHaveText(['Контекст','Три пробела']);
 await expect.poll(()=>page.evaluate(()=>window.previewState().decorations.filter(d=>d.to>d.from).map(d=>[d.from,d.to]))).toEqual([[0,5],[15,22]]);
 // Clicking a rendered heading brings the source back for editing.
 await page.locator('.h4').first().click();
 await expect(page.locator('.h4')).toHaveText(['#### Контекст','Три пробела']);
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
});

test('invalid Mermaid does not append error diagrams to the document',async({page})=>{
 await openEditor(page,'Before\n\n~~~mermaid\nsequenceDiagram\nJulia: plot()\n~~~\n');
 await expect(page.locator('.diagram')).toContainText('Ошибка Mermaid');
 await expect(page.locator('body > div[id^="ddiagram-"]')).toHaveCount(0);
 await expect(page.locator('svg')).toHaveCount(0);
});

test('mouse edits inside an inactive code block like plain text',async({page})=>{
 await openEditor(page,'Before\n\n~~~js\nfirst\nsecond\nthird\n~~~\n\nAfter');
 const line=page.locator('.cm-line').filter({hasText:/^second$/});
 const box=await line.boundingBox();
 await page.mouse.dblclick(box.x+24,box.y+box.height/2);
 expect(await page.evaluate(()=>{const v=window.editorView(),s=v.state.selection.main;return v.state.doc.sliceString(s.from,s.to);})).toBe('second');
});

test('line numbers render in the gutter and follow code block editing',async({page})=>{
 await openEditor(page,'# One\n\ntext\n\n~~~js\na\nb\n~~~\n');
 await expect(page.locator('.cm-lineNumbers')).toBeVisible();
 await expect(page.locator('.cm-lineNumbers .cm-gutterElement:visible').first()).toHaveText('1');
 await page.locator('.cm-line').filter({hasText:/^b$/}).click();
 await expect.poll(async()=>page.locator('.cm-lineNumbers .cm-gutterElement').allTextContents()).toContain('6');
});

test('bare, angle and inline links are clickable',async({page})=>{
 const text='See https://example.com/x, then <https://example.org/y> and www.example.net plus [label](https://example.com/z).\n\nTail';
 await openEditor(page,text);
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:window.editorView().state.doc.length}}));
 const links=page.locator('a');
 await expect(links).toHaveCount(4);
 await expect(links.nth(0)).toHaveAttribute('href','https://example.com/x');
 await expect(links.nth(1)).toHaveAttribute('href','https://example.org/y');
 await expect(links.nth(2)).toHaveAttribute('href','https://www.example.net');
 await expect(links.nth(3)).toHaveAttribute('href','https://example.com/z');
 await links.nth(0).click();
 await expect.poll(()=>page.evaluate(()=>window.messages.find(m=>m.type==='openLink'))).toEqual({type:'openLink',href:'https://example.com/x'});
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
});

test('inactive code blocks stay as source with visible fences and keep editing native',async({page})=>{
 const text='Intro\n\n~~~js\nalpha\nbeta\n~~~\n\nOutro';
 await openEditor(page,text);
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:0}}));
 await expect(page.locator('.code-fence').first()).toHaveText('~~~js');
 await expect(page.locator('.code-fence').last()).toHaveText('~~~');
 await expect(page.locator('.cm-line.code-source')).toHaveCount(4);
 await expect(page.locator('.rendered-block')).toHaveCount(0);
 const line=page.locator('.cm-line').filter({hasText:/^alpha$/});
 const box=await line.boundingBox();
 await page.mouse.click(box.x+20,box.y+box.height/2);
 expect(await page.evaluate(()=>window.editorView().state.doc.lineAt(window.editorView().state.selection.main.head).text)).toBe('alpha');
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
});

test('clicking text below rendered widgets selects the clicked line',async({page})=>{
 const text=['# T','','Before the widgets','','```js','const a = 1;','const b = 2;','```','','After the code block','','| A | B |','| - | - |','| 1 | 2 |','','After the table'].join('\n');
 await openEditor(page,text);
 await expect(page.locator('.rendered-block table')).toContainText('1');
 // Widget spacing must live inside the measured widget box, otherwise the
 // height map runs short and clicks below widgets land several lines low.
 expect(await page.locator('.rendered-block').evaluate(el=>parseFloat(getComputedStyle(el).marginTop))).toBe(0);
 for(const probe of ['Before the widgets','After the code block','After the table']){
  const line=page.locator('.cm-content .cm-line').filter({hasText:probe}).first();
  const box=await line.boundingBox();
  await page.mouse.click(box.x+40,box.y+box.height/2);
  expect(await page.evaluate(()=>window.editorView().state.doc.lineAt(window.editorView().state.selection.main.head).text),probe).toBe(probe);
 }
});

test('julia code is highlighted in the always-visible source without a sheet look',async({page})=>{
 const text='# T\n\n~~~julia\nfunction f(x)\n  return x^2  # note\nend\n~~~';
 await openEditor(page,text);
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:0}}));
 await expect(page.locator('.cm-line.code-source .hljs-keyword').first()).toHaveText('function');
 await expect(page.locator('.cm-line.code-source .hljs-comment').first()).toHaveText('# note');
 const style=await page.locator('.cm-line.code-source').first().evaluate(el=>({background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderTopWidth}));
 expect(style.background).toBe('rgba(0, 0, 0, 0)');
 expect(style.border).toBe('0px');
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
});

test('a blank first line inside a code block does not shift highlight spans',async({page})=>{
 // The HTML parser drops the leading newline of the block content, which used
 // to shift every highlight.js span one character left.
 const text='~~~julia\n\nplot_registry = Dict()\n\nend\n~~~';
 await openEditor(page,text);
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:0}}));
 await expect(page.locator('.cm-line.code-source .hljs-built_in')).toHaveText('Dict');
 await expect(page.locator('.cm-line.code-source .hljs-keyword')).toHaveText('end');
 const keywordLine=await page.locator('.cm-line.code-source').filter({hasText:'end'}).first().evaluate(el=>el.innerHTML);
 expect(keywordLine).toBe('<span class="hljs-keyword">end</span>');
});

test('single line breaks stay visible line breaks without changing the Markdown',async({page})=>{
 const text='# Title\n\nFirst line\nsecond line\n\nNext paragraph\n\n- First item\n  continuation\n- Second item\n\n> Quoted line\n> continued quote\n\nHard break  \nstays here\\\nand here\n\n~~~txt\ncode one\ncode two\n~~~';
 await openEditor(page,text);
 await expect(page.locator('.cm-line').filter({hasText:/^First line$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^second line$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^\s*continuation$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^- Second item$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^\s*Quoted line$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^\s*continued quote$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^Hard break/})).toHaveText('Hard break  ');
 await expect(page.locator('.cm-line').filter({hasText:/^stays here/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^Next paragraph$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^code one$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^code two$/})).toHaveCount(1);
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);

 // Selecting the paragraph keeps the same lines on screen.
 await page.locator('.cm-line').filter({hasText:/^First line$/}).click();
 await page.evaluate(()=>{const view=window.editorView();const line=view.state.doc.line(3);view.dispatch({selection:{anchor:line.from,to:line.to}});});
 await expect(page.locator('.cm-line').filter({hasText:/^First line$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^second line$/})).toHaveCount(1);
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:0}}));
 await expect(page.locator('.cm-line').filter({hasText:/^First line$/})).toHaveCount(1);
 await expect(page.locator('.cm-line').filter({hasText:/^second line$/})).toHaveCount(1);
});

test('paragraphs and balanced table columns use the available editor width',async({page})=>{
 const text='# Title\n\n'+('Wide paragraph content. '.repeat(30))+'\n\n| | Чип-антенна | FPC-диполь |\n| --- | --- | --- |\n| Что излучает | Плата | https://example.com/'+('long-path'.repeat(30))+' |';
 await openEditor(page,text);
 for(const width of [1600,700]){
  await page.setViewportSize({width,height:900});
  const table=page.locator('.rendered-block table');
  await expect(table).toBeVisible();
  const lineWidth=await page.locator('.cm-content').evaluate(el=>el.getBoundingClientRect().width)-48;
  await expect.poll(async()=>Math.round((await table.boundingBox()).width)).toBe(Math.round(lineWidth-24));
  const cells=await table.locator('th').evaluateAll(cells=>cells.map(cell=>cell.getBoundingClientRect().width));
  expect(Math.max(...cells)-Math.min(...cells)).toBeLessThan(1);
  const paragraph=await page.locator('.cm-line').filter({hasText:/^Wide paragraph/}).boundingBox();
  expect(paragraph.width).toBeCloseTo(lineWidth,0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
 }
});

const imageData='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><rect width="1600" height="400" fill="green"/></svg>');

test('relative images load, fit the editor and reveal editable Markdown on click',async({page})=>{
 const raw='![ДН на плате](figures/sim_patterns_board.png "Диаграмма")';
 const text='# Title\n\n'+raw+'\n\nAfter';
 await openEditor(page,text,{'figures/sim_patterns_board.png':imageData});
 const img=page.locator('.markdown-image img');
 await expect(img).toHaveAttribute('alt','ДН на плате');
 await expect(img).toHaveAttribute('title','Диаграмма');
 await expect.poll(()=>img.evaluate(img=>img.naturalWidth)).toBe(1600);
 for(const width of [1200,500]){
  await page.setViewportSize({width,height:900});
  const lineWidth=await page.locator('.cm-content').evaluate(el=>el.getBoundingClientRect().width)-48;
  await expect.poll(async()=>Math.round((await img.boundingBox()).width)).toBeLessThanOrEqual(Math.ceil(lineWidth));
  expect((await img.boundingBox()).width).toBeGreaterThan(lineWidth-16);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
 }
 await img.click();
 await expect(img).toHaveCount(0);
 await expect(page.locator('.cm-line').filter({hasText:raw})).toHaveCount(1);
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:0}}));
 await expect(img).toBeVisible();
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
});

test('reference and inline images render, while code keeps image syntax literal',async({page})=>{
 const text='# Title\n\nBefore ![Inline](figures/test.png) after\n\n![Reference][plot]\n\n![Multi\nline](figures/test.png)\n\n[plot]: figures/test.png "Plot"\n\n`![Code](figures/test.png)`\n\n~~~md\n![Code block](figures/test.png)\n~~~';
 await openEditor(page,text,{'figures/test.png':imageData});
 await expect(page.locator('.markdown-image img')).toHaveCount(3);
 await expect(page.locator('.markdown-image img[alt="Reference"]')).toHaveAttribute('title','Plot');
 await expect(page.locator('.cm-line').filter({hasText:'![Code block](figures/test.png)'})).toHaveCount(1);
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
});

test('failed images stay editable and newly resolved image paths refresh after saving edits',async({page})=>{
 const text='# Title\n\n![Missing](figures/missing.png)';
 await page.route('https://images.test/missing.png',route=>route.fulfill({status:404,body:'Missing'}));
 await openEditor(page,text,{'figures/missing.png':'https://images.test/missing.png'});
 await expect(page.locator('.image-unavailable')).toHaveText('Не удалось загрузить изображение: Missing');
 await page.locator('.image-unavailable').click();
 await page.evaluate(()=>{
  const view=window.editorView(),from=view.state.doc.toString().indexOf('missing.png');
  view.dispatch({changes:{from,to:from+'missing.png'.length,insert:'found.png'}});
  view.dispatch({selection:{anchor:0}});
 });
 await page.evaluate(src=>window.postMessage({type:'ack',version:2,imageSources:{'figures/found.png':src}},'*'),imageData);
 await expect.poll(()=>page.locator('.markdown-image img').evaluate(img=>img.naturalWidth)).toBe(1600);
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text.replace('missing.png','found.png'));
});
