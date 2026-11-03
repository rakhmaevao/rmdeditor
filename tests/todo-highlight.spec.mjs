import {test,expect} from '@playwright/test';
import {openEditor} from './harness.mjs';

const todoDecos=page=>page.evaluate(()=>{
 const state=window.previewState();
 return state.decorations.filter(d=>d.class&&d.class.includes('todo')).map(d=>({from:d.from,to:d.to,class:d.class,text:window.editorView().state.doc.sliceString(d.from,d.to)}));
});

test('a paragraph starting with TODO gets a colored band over every line',async({page})=>{
 const text='Intro\n\nTODO: buy milk\n\nFIXME: broken thing\n\nplain text\n\ntodo: lowercase stays plain';
 await openEditor(page,text);
 const lines=page.locator('.cm-line.todo-paragraph-highlight');
 await expect(lines).toHaveCount(2);
 const styles=await lines.evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return{background:s.backgroundColor,color:s.color,radius:s.borderRadius};}));
 expect(styles[0]).toEqual({background:'rgb(255, 189, 42)',color:'rgb(255, 255, 255)',radius:'6px'});
 expect(styles[1].background).toBe('rgb(240, 98, 146)');
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
});

test('the band spans a multi-line TODO paragraph and keeps the document intact',async({page})=>{
 const text='TODO: first\nsecond\nthird\n\nAfter';
 await openEditor(page,text);
 await expect.poll(()=>page.evaluate(()=>window.previewState().parsed)).toBe(text.length);
 expect(await todoDecos(page)).toEqual([
  {from:0,to:0,class:'todo-paragraph-highlight todo-rule-todo todo-paragraph-start',text:''},
  {from:12,to:12,class:'todo-paragraph-highlight todo-rule-todo',text:''},
  {from:19,to:19,class:'todo-paragraph-highlight todo-rule-todo todo-paragraph-end',text:''},
 ]);
 // The cursor sits inside the paragraph, so its lines stay separate.
 const lines=page.locator('.cm-line.todo-paragraph-highlight');
 await expect(lines).toHaveCount(3);
 const radius=await lines.evaluateAll(els=>els.map(el=>getComputedStyle(el).borderRadius));
 expect(radius).toEqual(['6px 6px 0px 0px','0px','0px 0px 6px 6px']);
 // Lines stay separate: the cursor position does not change the bands.
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:window.editorView().state.doc.length}}));
 await expect(page.locator('.cm-line.todo-paragraph-highlight')).toHaveCount(3);
 expect(await lines.evaluateAll(els=>els.map(el=>getComputedStyle(el).borderRadius))).toEqual(['6px 6px 0px 0px','0px','0px 0px 6px 6px']);
 expect(await todoDecos(page).then(decos=>decos.map(d=>d.class))).toEqual([
  'todo-paragraph-highlight todo-rule-todo todo-paragraph-start',
  'todo-paragraph-highlight todo-rule-todo',
  'todo-paragraph-highlight todo-rule-todo todo-paragraph-end',
 ]);
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
});

test('an inline marker highlights to the end of its sentence',async({page})=>{
 const text='Before TODO: fix this. After\n\nAlso FIXME: wrap (parens) end\n\nWrapped intro\ncontinues TODO: here.\n\n~~~js\n// TODO: in code\n~~~';
 await openEditor(page,text);
 const marks=page.locator('.cm-line .todo-paragraph-inline');
 await expect(marks).toHaveCount(3);
 await expect(marks.nth(0)).toHaveText('TODO: fix this.');
 await expect(marks.nth(1)).toHaveText('FIXME: wrap (parens');
 await expect(marks.nth(2)).toHaveText('TODO: here.');
 expect(await todoDecos(page).then(decos=>decos.filter(d=>d.class.includes('inline')).map(d=>d.text))).toEqual(['TODO: fix this.','FIXME: wrap (parens','TODO: here.']);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
});

test('inline markers also highlight inside lists, quotes and headings',async({page})=>{
 const text='- item with TODO: fix me\n\n- TODO: whole item\n\n> quoted TODO: and this\n\n## TODO: heading marker\n\n- plain item\n';
 await openEditor(page,text);
 expect(await todoDecos(page).then(decos=>decos.map(d=>d.text))).toEqual(['TODO: fix me','TODO: whole item','TODO: and this','TODO: heading marker']);
 await expect(page.locator('.cm-line.todo-paragraph-highlight')).toHaveCount(0);
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
});

test('frontmatter, code fences and lowercase keywords stay plain',async({page})=>{
 const text='---\nTODO: meta\n---\n\ntodo: lowercase\n\n~~~txt\nTODO: in fence\n~~~\n';
 await openEditor(page,text);
 await expect(page.locator('.todo-paragraph-highlight')).toHaveCount(0);
 expect(await todoDecos(page)).toEqual([]);
});
