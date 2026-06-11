/* Final visual verification — full-page screenshots of each node panel. */
import { chromium } from 'playwright';
const FLOW_ID = process.argv[2];
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

const shots = [
  ['انتظار پاسخ', 'wait'],
  ['شرط', 'if'],
  ['ارسال پیام', 'send'],
  ['شروع', 'trigger'],
];
for (const [label, name] of shots) {
  await page.mouse.click(700, 560); // deselect
  await page.waitForTimeout(200);
  await page.locator('.react-flow__node', { hasText: label }).first().click({ position: { x: 60, y: 14 } });
  await page.waitForTimeout(450);
  await page.screenshot({ path: `/tmp/ui-shots/final-${name}.png` });
}
// hints dropdown open
await page.locator('[data-testid="param-panel"] .expr-fx').first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/ui-shots/final-hints.png' });
await browser.close();
console.log('shots saved');
