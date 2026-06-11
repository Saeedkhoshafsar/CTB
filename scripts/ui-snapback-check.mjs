/* eslint-disable no-console */
/**
 * Regression check for the reported ساده⇄پیشرفته snap-back bug.
 * Drives the exact user gesture: select waitForReply → switch tabs with
 * empty/non-empty text → assert the chosen tab survives the debounce+prune.
 *
 * Usage: node scripts/ui-snapback-check.mjs <FLOW_ID>
 */
import { chromium } from 'playwright';

const FLOW_ID = process.argv[2];
if (!FLOW_ID) throw new Error('usage: node scripts/ui-snapback-check.mjs <FLOW_ID>');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:3000/#/login');
await page.fill('form input:not([type="password"])', 'admin');
await page.fill('input[type="password"]', process.env.CTB_ADMIN_PASS ?? 'hunter2hunter2');
await page.click('button[type="submit"]');
await page.waitForTimeout(700);
await page.goto(`http://localhost:3000/#/flows/${FLOW_ID}`);
await page.waitForSelector('.react-flow__node', { timeout: 10000 });
await page.waitForTimeout(500);

// select the waitForReply node
await page.locator('.react-flow__node', { hasText: 'انتظار پاسخ' }).first().click({ position: { x: 60, y: 14 } });
await page.waitForTimeout(400);
const panel = page.locator('[data-testid="param-panel"]');

// 1) fixture prompt is the OBJECT branch → switch to ساده; text must carry over
const simpleTab = panel.locator('.union-tabs button', { hasText: 'ساده' }).first();
await simpleTab.click();
await page.waitForTimeout(200);
const promptInput = panel.locator('.union-widget .expr-box input, .union-widget .expr-box textarea').first();
console.log('after advanced→simple, text =', JSON.stringify(await promptInput.inputValue()));

// 2) CLEAR the text entirely (this is what used to trigger the snap-back)
await promptInput.fill('');
await page.waitForTimeout(900); // past COMMIT_MS — prune drops empty prompt
const advTab = panel.locator('.union-tabs button', { hasText: 'پیشرفته' }).first();
await advTab.click();
await page.waitForTimeout(150);
console.log('clicked پیشرفته with EMPTY text; active(150ms) =', (await advTab.getAttribute('class'))?.includes('active'));
await page.waitForTimeout(1000); // well past debounce+prune
console.log('active(1150ms, post-prune) =', (await advTab.getAttribute('class'))?.includes('active'));

// 3) type text in advanced mode, switch back — must be preserved
const advText = panel.locator('.union-widget .expr-box textarea, .union-widget .expr-box input').first();
await advText.fill('اسمت چیه؟');
await page.waitForTimeout(800);
await simpleTab.click();
await page.waitForTimeout(300);
console.log(
  'advanced→simple carries text =',
  JSON.stringify(
    await panel.locator('.union-widget .expr-box input, .union-widget .expr-box textarea').first().inputValue(),
  ),
);
await page.screenshot({ path: '/tmp/ui-shots/07-snapback-check.png' });
await browser.close();
console.log('DONE');
