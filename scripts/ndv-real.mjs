import { chromium } from 'playwright';
const BASE = 'http://localhost:5173', FLOW_ID = process.argv[2], PASS = 'demopass';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error' && !m.text().includes('401')) errs.push(m.text()); });

await p.goto(`${BASE}/#/login`, { waitUntil: 'load' });
await p.waitForSelector('form.login-card', { timeout: 15000 });
await p.fill('input[autocomplete="username"]', 'admin');
await p.fill('input[type="password"]', PASS);
await p.click('button[type="submit"]');
await p.waitForTimeout(1500);
await p.goto(`${BASE}/#/flows/${FLOW_ID}`, { waitUntil: 'load' });
await p.waitForSelector('.react-flow__node', { timeout: 12000 });
await p.waitForTimeout(1200);

const node = p.locator('[data-id="code_1"]');
const box = await node.boundingBox();
const x = box.x + 40, y = box.y + 18;

// Drive a REAL browser double-click via CDP Input domain — clickCount:1 then
// clickCount:2 with the same coords produces a genuine `dblclick` exactly as
// Chrome fires for a human's double-click.
const cdp = await ctx.newCDPSession(p);
async function down(cnt) { await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: cnt }); }
async function up(cnt) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: cnt }); }
await down(1); await up(1);
await p.waitForTimeout(40);
await down(2); await up(2);
await p.waitForTimeout(600);

const overlay = await p.locator('.ndv-overlay').count();
console.log('REAL browser dblclick (CDP) -> NDV:', overlay ? 'OPENED ✅' : 'no modal ❌');
if (overlay) {
  await p.screenshot({ path: '/tmp/ui-shots/09-code-ndv.png' });
  console.log('  -> screenshot saved 09-code-ndv.png');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  console.log('after Escape -> overlay:', await p.locator('.ndv-overlay').count());
}
console.log('errors:', errs.length ? errs : '(none)');
await b.close();
