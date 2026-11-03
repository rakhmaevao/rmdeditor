import {test,expect} from '@playwright/test';
import {openEditor} from './harness.mjs';

const text='one two\n\nthree one\n\nOne!\n\n~~~js\none\n~~~\n';

test('Ctrl+F finds, counts and navigates matches like a regular editor',async({page})=>{
 await openEditor(page,text);
 await page.evaluate(()=>window.editorView().focus());
 await page.keyboard.press('Control+f');
 const panel=page.locator('.rmd-search');
 await expect(panel).toBeVisible();
 const field=page.locator('.rmd-search input[main-field]');
 await expect(field).toBeFocused();
 await page.keyboard.type('one');
 await expect(field).toHaveValue('one');
 // Code blocks render as source, so every match is visible at once.
 await expect(page.locator('.cm-searchMatch')).toHaveCount(4);
 await expect(panel.locator('.rmd-count')).toHaveText('1 из 4');
 await page.keyboard.press('Enter');
 await expect(panel.locator('.rmd-count')).toHaveText('2 из 4');
 expect(await page.evaluate(()=>window.editorView().state.selection.main.from)).toBe(text.indexOf('one',1));
 await page.keyboard.press('Shift+Enter');
 await expect(panel.locator('.rmd-count')).toHaveText('1 из 4');
 await page.keyboard.press('F3');
 await expect(panel.locator('.rmd-count')).toHaveText('2 из 4');
 await page.keyboard.press('Escape');
 await expect(panel).toHaveCount(0);
 await expect(page.locator('.cm-searchMatch')).toHaveCount(0);
});

test('case toggle and replace-all edit the document',async({page})=>{
 await openEditor(page,text);
 await page.evaluate(()=>window.editorView().focus());
 await page.keyboard.press('Control+h');
 const panel=page.locator('.rmd-search');
 await expect(page.locator('.rmd-replace')).toBeVisible();
 await page.keyboard.type('one');
 await expect(panel.locator('.rmd-count')).toHaveText('1 из 4');
 await panel.locator('button.rmd-toggle').first().click();
 await expect(panel.locator('.rmd-count')).toHaveText('1 из 3');
 await page.fill('.rmd-replace input','uno');
 await panel.locator('button',{hasText:'Заменить всё'}).click();
 const replaced='uno two\n\nthree uno\n\nOne!\n\n~~~js\nuno\n~~~\n';
 expect(await page.evaluate(()=>window.previewState().text)).toBe(replaced);
 expect(await page.evaluate(()=>window.messages.filter(m=>m.type==='edit').at(-1)?.text)).toBe(replaced);
 await expect(panel.locator('.rmd-count')).toHaveText('Нет совпадений');
});

test('regexp mode works and invalid input is reported without a crash',async({page})=>{
 await openEditor(page,'one two\n\nthree four');
 await page.evaluate(()=>window.editorView().focus());
 await page.keyboard.press('Control+f');
 const panel=page.locator('.rmd-search');
 const field=page.locator('.rmd-search input[main-field]');
 await page.keyboard.type('o.e');
 await expect(panel.locator('.rmd-count')).toHaveText('Нет совпадений');
 await panel.locator('button.rmd-toggle').last().click();
 await expect(field).toHaveValue('o.e');
 await expect(panel.locator('.rmd-count')).toHaveText('1 из 1');
 await expect(page.locator('.cm-searchMatch')).toHaveCount(1);
 await page.keyboard.type('(');
 await expect(field).toHaveClass(/rmd-invalid/);
 await expect(panel.locator('.rmd-count')).toHaveText('');
 await page.keyboard.press('Escape');
 await expect(panel).toHaveCount(0);
});
