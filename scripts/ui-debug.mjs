/* eslint-disable no-console */
/**
 * UI debug harness — reproduces the param-panel bugs reported on P2-T3.
 * Boots a headless Chromium, logs in, opens the seeded "panel-smoke" flow,
 * pokes the panel like a user would, and dumps screenshots + findings.
 *
 * Usage: node scripts/ui-debug.mjs <FLOW_ID> [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const FLOW_ID = process.argv[2];
const OUT = process.argv[3] ?? '/tmp/ui-shots';
if (!FLOW_ID) throw new Error('usage: node scripts/ui-debug.mjs <FLOW_ID>');
mkdirSync(OUT, { recursive: true });

const BASE = 'http://localhost:3000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));

// ── login ──
await page.goto(`${BASE}/#/login`);
await page.fill('input[name="username"], input[autocomplete="username"], form input:not([type="password"])', 'admin');
await page.fill('input[type="password"]', process.env.CTB_ADMIN_PASS ?? 'hunter2hunter2');
await page.click('button[type="submit"]');
await page.waitForTimeout(800);

// ── open flow editor ──
await page.goto(`${BASE}/#/flows/${FLOW_ID}`);
await page.waitForSelector('.react-flow__node', { timeout: 10000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/01-canvas.png` });

const report = [];
const log = (s) => { report.push(s); console.log(s); };

async function selectNodeByLabel(label) {
  // click empty canvas first to clear selection
  await page.mouse.click(700, 520);
  await page.waitForTimeout(200);
  const node = page.locator('.react-flow__node', { hasText: label }).first();
  await node.click({ position: { x: 60, y: 14 } });
  await page.waitForTimeout(400);
}

// ════ BUG 1: union tabs (ساده/پیشرفته) on waitForReply prompt ════
await selectNodeByLabel('انتظار پاسخ');
const panel = page.locator('[data-testid="param-panel"]');
if (!(await panel.isVisible())) { log('FAIL: panel did not open for waitForReply'); }
await page.screenshot({ path: `${OUT}/02-wait-panel.png` });

// find the union tabs
const tabs = panel.locator('.union-tabs button');
const tabCount = await tabs.count();
log(`union tabs count: ${tabCount}`);
for (let i = 0; i < tabCount; i++) {
  const txt = await tabs.nth(i).innerText();
  const box = await tabs.nth(i).boundingBox();
  const panelBox = await panel.boundingBox();
  log(`tab[${i}] text="${txt}" box=${JSON.stringify(box)} panel.x=${panelBox?.x} panel.right=${panelBox ? panelBox.x + panelBox.width : '?'}`);
  if (box && panelBox && (box.x < panelBox.x || box.x + box.width > panelBox.x + panelBox.width)) {
    log(`  ⚠ tab[${i}] OVERFLOWS the panel horizontally`);
  }
}

// click "پیشرفته" (advanced) and watch whether it sticks
const advTab = panel.locator('.union-tabs button', { hasText: 'پیشرفته' }).first();
if (await advTab.count()) {
  await advTab.click();
  await page.waitForTimeout(150);
  let cls = await advTab.getAttribute('class');
  log(`after click پیشرفته (150ms): class="${cls}" active=${cls?.includes('active')}`);
  await page.waitForTimeout(900); // beyond COMMIT_MS=600 debounce
  cls = await advTab.getAttribute('class');
  log(`after click پیشرفته (1050ms, post-debounce): active=${cls?.includes('active')}`);
  await page.screenshot({ path: `${OUT}/03-advanced-after-debounce.png` });
} else {
  log('no پیشرفته tab found');
}

// ════ BUG 2: expression hints dropdown clipping on IF node ════
await selectNodeByLabel('شرط');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/04-if-panel.png` });
const fx = panel.locator('.expr-fx').first();
if (await fx.count()) {
  await fx.click();
  await page.waitForTimeout(250);
  const hints = panel.locator('.expr-hints').first();
  if (await hints.isVisible()) {
    const hb = await hints.boundingBox();
    const pb = await panel.boundingBox();
    log(`hints box=${JSON.stringify(hb)} panel=${JSON.stringify(pb)}`);
    if (hb && pb) {
      const vw = page.viewportSize().width, vh = page.viewportSize().height;
      if (hb.x < 0 || hb.y < 0 || hb.x + hb.width > vw || hb.y + hb.height > vh)
        log('  ⚠ hints dropdown leaves the VIEWPORT');
      else log('  ✓ hints dropdown fully inside the viewport');
      // check actual visibility of items (overflow of scroll container)
      const item = hints.locator('button').first();
      const ib = await item.boundingBox();
      log(`first hint item box=${JSON.stringify(ib)}`);
      const txt = await item.innerText();
      log(`first hint item text="${txt}"`);
    }
    await page.screenshot({ path: `${OUT}/05-if-hints-open.png` });
  } else {
    log('hints dropdown did not open');
  }
}

// ════ check field labels / descriptions presence ════
const labels = await panel.locator('.field-label').allInnerTexts();
log(`IF panel field labels: ${JSON.stringify(labels)}`);
const descCount = await panel.locator('.field-desc, .hint').count();
log(`description/hint elements in panel: ${descCount}`);

// ════ sendMessage node panel ════
await selectNodeByLabel('ارسال پیام');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/06-send-panel.png` });

// ════ console errors ════
log('--- console errors/warnings ---');
for (const e of consoleErrors.slice(0, 30)) log(e);

await browser.close();
console.log('\nDONE. shots in ' + OUT);
