import { chromium } from 'playwright';
const BASE = 'http://localhost:5173', FLOW_ID = process.argv[2], PASS = 'demopass';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
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

async function overlayCount() { return p.locator('.ndv-overlay').count(); }
const node = p.locator('[data-id="code_1"]');
await node.scrollIntoViewIfNeeded().catch(() => {});

// Real Playwright dblclick — synthesises a native dblclick on the node, which
// bubbles to our wrapper's onDoubleClick. This is the exact gesture a real
// user makes (two quick clicks => browser fires dblclick).
await node.dblclick({ position: { x: 40, y: 18 } });
await p.waitForTimeout(500);
const a = await overlayCount();
console.log('dblclick on code node -> NDV:', a ? 'OPENED ✅' : 'no modal ❌');
if (a) {
  await p.waitForTimeout(300);
  await p.screenshot({ path: '/tmp/ui-shots/09-code-ndv.png' });
  console.log('  -> screenshot saved 09-code-ndv.png');
  // sanity: close on Escape / backdrop
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  console.log('after Escape -> overlay:', await overlayCount());
}
console.log('errors:', errs.length ? errs : '(none)');
await b.close();
