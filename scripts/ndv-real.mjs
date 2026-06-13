// Regression probe: verifies the data.code node's NDV opens on double-click
// AND the "اجرای آزمایشی" (Test-run) button runs the flow and refreshes data.
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

// ---- 1) NDV double-click (real browser dblclick via CDP) ----
const node = p.locator('[data-id="code_1"]');
const box = await node.boundingBox();
const x = box.x + 40, y = box.y + 18;
const cdp = await ctx.newCDPSession(p);
const md = (n) => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: n });
const mu = (n) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: n });
await md(1); await mu(1); await p.waitForTimeout(40); await md(2); await mu(2);
await p.waitForTimeout(600);
console.log('1) NDV on double-click:', (await p.locator('.ndv-overlay').count()) ? 'OPENED ✅' : 'no modal ❌');
await p.keyboard.press('Escape');
await p.waitForTimeout(400);

// ---- 2) Test-run button ("اجرای آزمایشی") ----
const runBtn = p.locator('button', { hasText: 'اجرای آزمایشی' });
const runCount = await runBtn.count();
console.log('2) Test-run button present:', runCount ? 'yes ✅' : 'NO ❌');
if (runCount) {
  await runBtn.first().click();
  await p.waitForTimeout(2500); // let the run dispatch + run-data refresh
  // After a run, the code node shows a per-node "n items" run badge.
  const badge = await p.locator('.ctb-node-run').count();
  console.log('   run badge on node(s):', badge);
  await p.screenshot({ path: '/tmp/ui-shots/10-test-run.png' });
  console.log('   -> screenshot saved 10-test-run.png');
}
console.log('errors:', errs.length ? errs : '(none)');
await b.close();
