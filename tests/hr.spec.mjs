import {test,expect} from '@playwright/test';
import {openEditor} from './harness.mjs';

test('a thematic break renders as a horizontal rule until the cursor enters its line',async({page})=>{
 const text='Before\n\n---\n\nAfter\n';
 await openEditor(page,text);
 await expect.poll(()=>page.evaluate(()=>window.previewState().parsed)).toBe(text.length);
 const rules=page.locator('.cm-line.markdown-hr');
 await expect(rules).toHaveCount(1);
 await expect(rules).toHaveText('');
 const border=await rules.evaluate(el=>{const s=getComputedStyle(el);return{width:s.borderBottomWidth,color:s.borderBottomColor};});
 expect(border).toEqual({width:'2px',color:'rgb(216, 222, 233)'});
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
 // Moving the cursor onto the line brings back the raw dashes.
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:9}}));
 await expect(page.locator('.cm-line.markdown-hr')).toHaveCount(0);
 await expect(page.locator('.cm-line').nth(2)).toHaveText('---');
});

test('all thematic break markers render as rules, setext underlines do not',async({page})=>{
 const text='***\n\n___\n\nTitle\n===\n\nSubtitle\n---\n\nAfter\n';
 await openEditor(page,text);
 await expect.poll(()=>page.evaluate(()=>window.previewState().parsed)).toBe(text.length);
 // The opening cursor sits on `***`, so move it away: only lines outside the
 // selection render as rules.
 await page.evaluate(()=>window.editorView().dispatch({selection:{anchor:window.editorView().state.doc.length}}));
 await expect(page.locator('.cm-line.markdown-hr')).toHaveCount(2);
 // `Subtitle\n---` is a setext heading, so its underline stays a header mark.
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
 await expect(page.locator('.cm-line').filter({hasText:'Subtitle'})).toHaveText('Subtitle');
});

test('frontmatter delimiters stay plain, later rules still render',async({page})=>{
 const text='---\nTODO: meta\n---\n\n# Head\n\n---\n';
 await openEditor(page,text);
 await expect.poll(()=>page.evaluate(()=>window.previewState().parsed)).toBe(text.length);
 await expect(page.locator('.cm-line.markdown-hr')).toHaveCount(1);
 expect(await page.evaluate(()=>window.previewState().text)).toBe(text);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit'))).toEqual([]);
});
