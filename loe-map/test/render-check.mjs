// Local render and unlock check for the Lines of Effort Map.
//
// Usage:
//   node test/render-check.mjs <path-to-d3.min.js> <output-dir>
//
// The page is wrapped in the same skeleton the artifact host adds at publish
// time, D3 is served from a local copy (the cdnjs URL is routed to it), and
// window.claude is stubbed with an in-memory store that follows the db
// capability contract: frozen snapshot bodies, update() rejects on a missing
// document, snapshots delivered asynchronously.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [d3Path, outDir] = process.argv.slice(2);
if (!d3Path || !outDir) { console.error('usage: node test/render-check.mjs <d3.min.js> <out-dir>'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const page = readFileSync(join(here, '..', 'index.html'), 'utf8');
const skeleton = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${page}</body></html>`;
const wrapped = join(outDir, 'wrapped.html');
writeFileSync(wrapped, skeleton);
const url = pathToFileURL(resolve(wrapped)).href;
const D3 = readFileSync(d3Path, 'utf8');

// Runs inside the page before any page script.
function installStub({ canWrite, withDb }) {
  class StubDB {
    constructor() { this.docs = new Map(); this.subs = new Set(); this.q = false; }
    doc(path) {
      const self = this;
      return {
        id: path.split('/').pop(), path,
        get: async () => self.docSnap(path),
        set: async (data) => { await null; self.docs.set(path, Object.freeze({ ...data })); self.notify(); },
        update: async (patch) => {
          await null;
          if (!self.docs.has(path)) throw { code: 'invalid_argument', message: 'update on missing document' };
          self.docs.set(path, Object.freeze({ ...self.docs.get(path), ...patch })); self.notify();
        },
        delete: async () => { await null; self.docs.delete(path); self.notify(); },
        onSnapshot: (next) => { const s = { kind: 'doc', path, next }; self.subs.add(s); setTimeout(() => self.fire(s), 5); return () => self.subs.delete(s); },
      };
    }
    collection(path) {
      const self = this;
      return { path, doc: (id) => self.doc(path + '/' + (id || Math.random().toString(36).slice(2))),
        onSnapshot: (next) => { const s = { kind: 'col', path, next }; self.subs.add(s); setTimeout(() => self.fire(s), 5); return () => self.subs.delete(s); } };
    }
    docSnap(path) { const d = this.docs.get(path); return Object.freeze({ id: path.split('/').pop(), exists: !!d, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } }); }
    colSnap(path) {
      const n = path.split('/').length + 1;
      const docs = [...this.docs.keys()].filter(k => k.startsWith(path + '/') && k.split('/').length === n).sort().map(k => this.docSnap(k));
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    }
    fire(s) { if (this.subs.has(s)) s.next(s.kind === 'doc' ? this.docSnap(s.path) : this.colSnap(s.path)); }
    notify() { if (this.q) return; this.q = true; setTimeout(() => { this.q = false; this.subs.forEach(s => this.fire(s)); }, 10); }
  }
  const db = new StubDB();
  window.__stubDb = db;
  const user = { can: async (name) => (name === 'data.write' ? canWrite : null), isOwner: async () => true, canEdit: async () => canWrite, id: async () => 'u_test' };
  window.claude = { use: (name) => new Promise(r => setTimeout(() => r(name === 'db' ? (withDb ? db : null) : name === 'user' ? user : null), 60)) };
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());

async function open({ width, height, scheme = 'light', canWrite = true, withDb = true, mobile = false }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await ctx.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: D3 }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
  await ctx.addInitScript(installStub, { canWrite, withDb });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  await p.goto(url);
  await p.waitForFunction(() => window.LOEMap && window.LOEMap.ui.mode !== 'connecting', null, { timeout: 5000 });
  await p.waitForTimeout(250);
  return { ctx, p, errors };
}
const overflow = p => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const settle = p => p.waitForTimeout(220);
const shot = (p, name) => p.screenshot({ path: join(outDir, name + '.png') });

// ---------------------------------------------------------------- 1. Unlock path, desktop light
{
  const { ctx, p, errors } = await open({ width: 1360, height: 860 });
  let u = await p.evaluate(() => window.LOEMap.unlocks());
  check('empty store: only start and question 1 open', JSON.stringify(u) === JSON.stringify([true, true, false, false, false, false, false]), JSON.stringify(u));
  const locked = await p.$$eval('#rail .rail-step', bs => bs.map(b => b.disabled));
  check('rail shows steps 2-6 locked', JSON.stringify(locked) === JSON.stringify([false, false, true, true, true, true, true]), JSON.stringify(locked));
  await shot(p, '01-desktop-start-light');

  // Question 1 through the real form fields, as a user would type or dictate.
  await p.click('#rail .rail-step:nth-child(2)');
  await settle(p);
  await p.fill('#f-project_objective', 'Reduce median ED CT report turnaround from 45 to 30 minutes by 31 March 2027.');
  await p.fill('#f-project_title', 'ED CT turnaround');
  await p.waitForTimeout(1100);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('typing an objective opens question 2', u[2] === true, JSON.stringify(u));
  const stored = await p.evaluate(() => window.LOEMap.model().P.objective);
  check('objective saved to the shared store', /45 to 30/.test(stored || ''), stored);
  const nextEnabled = await p.$eval('#coach-foot button[data-cmd="next"]', b => !b.disabled);
  check('Next button enabled after answering', nextEnabled);
  await shot(p, '02-desktop-goal-light');

  // Question 2: add a way through the form and Enter key.
  await p.click('#coach-foot button[data-cmd="next"]');
  await settle(p);
  await p.fill('#new-way', 'Reading and assignment');
  await p.press('#new-way', 'Enter');
  await p.waitForTimeout(400);
  const wayId = await p.evaluate(() => window.LOEMap.model().loes[0] && window.LOEMap.model().loes[0].id);
  check('way created from the add row', !!wayId, wayId);
  const focusKept = await p.evaluate(() => document.activeElement && document.activeElement.id);
  check('focus stays in the add field for the next entry', focusKept === 'new-way', focusKept);
  await p.evaluate(async id => { await window.LOEMap.dispatch('updateWay', id, { capability: 'read and sign ED CT within target' }); }, wayId);
  await p.evaluate(async () => { await window.LOEMap.dispatch('addWay', 'Technologist throughput'); });
  await p.waitForTimeout(300);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('question 3 stays locked until a main effort is chosen', u[3] === false, JSON.stringify(u));
  await p.evaluate(async id => { await window.LOEMap.dispatch('setMain', id); }, wayId);
  await p.waitForTimeout(300);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('marking a main effort opens question 3', u[3] === true, JSON.stringify(u));

  // Question 3
  await p.evaluate(async id => { await window.LOEMap.dispatch('setDoer', id, 'On-duty radiologists'); }, wayId);
  await p.waitForTimeout(300);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  const cog = await p.evaluate(() => { const M = window.LOEMap.model(); return M.cogId && M.nodes.get(M.cogId).label; });
  check('naming the main doer opens question 4', u[4] === true, JSON.stringify(u));
  check('main effort doer is the center of gravity', cog === 'On-duty radiologists', cog);

  // Question 4
  await p.evaluate(async id => { await window.LOEMap.dispatch('addRequirement', id, 'Worklist prioritization rule', 'process'); }, wayId);
  await p.evaluate(async id => { await window.LOEMap.dispatch('addRequirement', id, 'Overnight coverage schedule', 'resource'); }, wayId);
  await p.waitForTimeout(400);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('a need for the center of gravity opens step 5', u[5] === true, JSON.stringify(u));
  const vulnId = await p.evaluate(() => { const M = window.LOEMap.model(); return [...M.nodes.values()].find(n => n.label === 'Overnight coverage schedule').id; });
  await p.evaluate(async id => { await window.LOEMap.dispatch('markVulnerable', id, true, 'One radiologist covers ED and inpatients after midnight.'); }, vulnId);
  await p.waitForTimeout(300);
  const vulns = await p.evaluate(() => window.LOEMap.model().vulns.map(n => n.label));
  check('vulnerable need recognized as a critical vulnerability', vulns.includes('Overnight coverage schedule'), JSON.stringify(vulns));
  await p.evaluate(() => window.LOEMap.dispatch('goto', 4));
  await settle(p);
  await shot(p, '03-desktop-needs-light');

  // Step 5 and 6
  await p.evaluate(async () => { await window.LOEMap.dispatch('addNode', 'Conference schedule', 'process', ''); });
  await p.waitForTimeout(300);
  const ids = await p.evaluate(() => { const M = window.LOEMap.model(); const f = l => [...M.nodes.values()].find(n => n.label === l).id; return [f('Overnight coverage schedule'), f('Conference schedule')]; });
  await p.evaluate(async ([a, b]) => { await window.LOEMap.dispatch('link', a, 'depends_on', b); }, ids);
  await p.evaluate(async () => { await window.LOEMap.dispatch('reviewLinks', true); });
  await p.waitForTimeout(300);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('marking relationships reviewed opens the review', u[6] === true, JSON.stringify(u));
  const dup = await p.evaluate(([a, b]) => window.LOEMap.dispatch('link', a, 'depends_on', b), ids);
  check('duplicate relationship is refused', dup === false);
  const selfNeed = await p.evaluate(async id => window.LOEMap.dispatch('addRequirement', id, 'On-duty radiologists', 'actor'), wayId);
  check('a doer cannot be its own need', selfNeed === false);

  await p.evaluate(() => window.LOEMap.dispatch('goto', 6));
  await settle(p);
  await shot(p, '04-desktop-review-light');
  await p.evaluate(() => window.LOEMap.dispatch('view', 'network'));
  await p.waitForTimeout(400);
  await shot(p, '05-desktop-network-light');

  // Re-render must not steal text the user is typing.
  await p.evaluate(() => window.LOEMap.dispatch('goto', 1));
  await settle(p);
  await p.click('#f-project_objectiveRationale');
  await p.keyboard.type('Shorter ED stays', { delay: 15 });
  await p.evaluate(() => window.__stubDb.doc('project/main').update({ measure: 'Median minutes' }));
  await p.waitForTimeout(250);
  await p.keyboard.type(' for patients', { delay: 15 });
  const typed = await p.$eval('#f-project_objectiveRationale', t => t.value);
  check('teammate update while typing keeps the text and cursor', typed === 'Shorter ED stays for patients', typed);

  // Deleting a node removes its links and clears a doer that pointed at it.
  const radId = await p.evaluate(() => window.LOEMap.model().cogId);
  await p.evaluate(async id => { await window.LOEMap.dispatch('deleteNode', id); }, radId);
  await p.waitForTimeout(400);
  const after = await p.evaluate(() => { const M = window.LOEMap.model(); return { cog: M.cogId, uses: M.links.filter(k => k.type === 'uses').length, step: window.LOEMap.ui.step, reach: window.LOEMap.reachable() }; });
  check('deleting the doer cascades its links and clears the center of gravity', after.cog === null && after.uses === 0, JSON.stringify(after));
  check('steps already opened stay open after an edit removes a prerequisite', after.reach === 6, JSON.stringify(after));

  check('desktop: no horizontal overflow', (await overflow(p)) <= 0);
  check('desktop flow: no console or page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------- 2. Worked example, both views, both themes, desktop and phone
for (const scheme of ['light', 'dark']) {
  for (const [label, vp, mobile] of [['desktop', { width: 1360, height: 860 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const { ctx, p, errors } = await open({ ...vp, scheme, mobile });
    await p.evaluate(() => window.LOEMap.dispatch('demo', true));
    await settle(p);
    const reach = await p.evaluate(() => window.LOEMap.reachable());
    check(`${label} ${scheme}: worked example opens all steps`, reach === 6, String(reach));
    if (label === 'desktop' && scheme === 'light') {
      const M = await p.evaluate(() => { const M = window.LOEMap.model(); return { cog: M.nodes.get(M.cogId).label, vulns: M.vulns.length, nodes: M.nodes.size, links: M.links.length }; });
      check('worked example: center of gravity is the on-duty radiologists', M.cog === 'On-duty radiologists', JSON.stringify(M));
      const disabled = await p.$$eval('#coach-body input, #coach-body textarea, #coach-body select', els => els.every(e => e.disabled));
      check('worked example is read-only', disabled);
    }
    if (mobile) {
      await p.evaluate(() => window.LOEMap.dispatch('goto', 3));
      await settle(p);
      await shot(p, `10-${label}-coach-${scheme}`);
      const fields = await p.$$eval('[contenteditable]', e => e.length);
      check(`${label} ${scheme}: no contenteditable widgets, so keyboard dictation works`, fields === 0);
      await p.tap('#tab-map');
      await settle(p);
      const vis = await p.evaluate(() => ({ coach: getComputedStyle(document.getElementById('coach')).display, map: getComputedStyle(document.getElementById('map')).display }));
      check(`${label} ${scheme}: Map tab shows the map and hides the coach`, vis.coach === 'none' && vis.map !== 'none', JSON.stringify(vis));
    }
    await p.evaluate(() => window.LOEMap.dispatch('view', 'lanes'));
    await p.waitForTimeout(300);
    await shot(p, `11-${label}-lanes-${scheme}`);
    if (mobile) {
      const box = await p.evaluate(() => {
        const c = document.getElementById('canvas').getBoundingClientRect();
        for (const g of document.querySelectorAll('#map-svg g.lnode.node')) {
          const r = g.getBoundingClientRect();
          const x = r.x + r.width / 2, y = r.y + r.height / 2;
          if (x > c.left + 10 && x < c.right - 10 && y > c.top + 10 && y < c.bottom - 80) return { x, y };
        }
        return null;
      });
      check(`${label} ${scheme}: a node is visible on the initial phone framing`, !!box);
      if (box) await p.touchscreen.tap(box.x, box.y);
      await settle(p);
      const infoShown = await p.$eval('#info', el => !el.hidden);
      check(`${label} ${scheme}: tapping a node shows its details bar`, infoShown);
      await shot(p, `12-${label}-lanes-selected-${scheme}`);
    }
    await p.evaluate(() => { window.LOEMap.dispatch('select', null); window.LOEMap.dispatch('view', 'network'); });
    await p.waitForTimeout(500);
    await shot(p, `13-${label}-network-${scheme}`);
    if (label === 'desktop') {
      await p.click('#key summary');
      await settle(p);
      await shot(p, `13b-${label}-key-${scheme}`);
      await p.click('#key summary');
    }
    await p.evaluate(() => window.LOEMap.dispatch('focus', true));
    await p.waitForTimeout(250);
    await shot(p, `14-${label}-network-focus-${scheme}`);
    await p.evaluate(() => { window.LOEMap.dispatch('focus', false); window.LOEMap.dispatch('tab', 'coach'); window.LOEMap.dispatch('goto', 6); });
    await settle(p);
    await shot(p, `15-${label}-review-${scheme}`);
    check(`${label} ${scheme}: no horizontal overflow`, (await overflow(p)) <= 0);
    check(`${label} ${scheme}: no console or page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

// ---------------------------------------------------------------- 3. Read-only viewer and no-db fallback
{
  const { ctx, p, errors } = await open({ width: 1200, height: 800, canWrite: false });
  await p.evaluate(() => window.LOEMap.dispatch('goto', 1));
  await settle(p);
  const dis = await p.$eval('#f-project_objective', e => e.disabled);
  const banner = await p.$eval('#banners', e => e.textContent);
  check('read-only viewer: answer fields disabled', dis);
  check('read-only viewer: banner explains how to get edit access', /invite you as an Editor/.test(banner), banner.trim());
  check('read-only viewer: no errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, p, errors } = await open({ width: 1200, height: 800, withDb: false });
  const mode = await p.evaluate(() => window.LOEMap.ui.mode);
  await p.evaluate(() => window.LOEMap.dispatch('goto', 1));
  await settle(p);
  await p.fill('#f-project_objective', 'Test objective 1');
  await p.waitForTimeout(1000);
  const u = await p.evaluate(() => window.LOEMap.unlocks());
  check('no shared store: falls back to a local session store', mode === 'local' && u[2] === true, mode + ' ' + JSON.stringify(u));
  check('no shared store: no errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}`);
process.exit(failed.length ? 1 : 0);
