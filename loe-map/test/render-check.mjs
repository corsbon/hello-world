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
// Playwright from the project's node_modules, or the cloud container's global copy.
const { chromium } = await import('playwright').catch(() => import('/opt/node22/lib/node_modules/playwright/index.mjs'));

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
  check('empty store: only start and question 1 open', JSON.stringify(u) === JSON.stringify([true, true, false, false, false, false, false, false, false]), JSON.stringify(u));
  const locked = await p.$$eval('#rail .rail-step', bs => bs.map(b => b.disabled));
  check('rail shows every step after question 1 locked', JSON.stringify(locked) === JSON.stringify([false, false, true, true, true, true, true, true, true]), JSON.stringify(locked));
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
  check('a way with an essential action opens question 3, with no main effort needed', u[3] === true, JSON.stringify(u));
  const way2 = await p.evaluate(() => window.LOEMap.model().loes.find(l => l.name === 'Technologist throughput').id);

  // Steps under the essential action: added through the form, kept in order, moved, ticked, removed.
  await p.evaluate(() => window.LOEMap.dispatch('goto', 2));
  await settle(p);
  for (const t of ['Agree the worklist rule', 'Add overnight coverage', 'Read from the flagged worklist']) {
    await p.fill(`#new-step-${wayId}`, t);
    await p.press(`#new-step-${wayId}`, 'Enter');
    await p.waitForTimeout(300);
  }
  let st = await p.evaluate(id => window.LOEMap.model().stepsByLoe.get(id).map(s => [s.order, s.text, s.slot]), wayId);
  check('three steps added through the add box, in order', JSON.stringify(st) === JSON.stringify([[1, 'Agree the worklist rule', 0], [2, 'Add overnight coverage', 1], [3, 'Read from the flagged worklist', 2]]), JSON.stringify(st));
  const stepFocus = await p.evaluate(() => document.activeElement && document.activeElement.id);
  check('focus stays in the step add box for the next entry', stepFocus === `new-step-${wayId}`, stepFocus);
  const sIds = await p.evaluate(id => window.LOEMap.model().stepsByLoe.get(id).map(s => s.id), wayId);
  await p.evaluate(async id => { await window.LOEMap.dispatch('moveStep', id, 1); }, sIds[1]);
  await p.waitForTimeout(300);
  st = await p.evaluate(id => window.LOEMap.model().stepsByLoe.get(id).map(s => s.text), wayId);
  check('moving a step down swaps it with the next one', st[1] === 'Read from the flagged worklist' && st[2] === 'Add overnight coverage', JSON.stringify(st));
  await p.evaluate(async id => { await window.LOEMap.dispatch('moveStep', id, -1); }, sIds[1]);
  await p.waitForTimeout(300);
  st = await p.evaluate(id => window.LOEMap.model().stepsByLoe.get(id).map(s => s.text), wayId);
  check('moving it back restores the order', st[1] === 'Add overnight coverage', JSON.stringify(st));
  await p.click(`#coach-body .step-row button[data-cmd="editStep"]`);
  await settle(p);
  const pageOpen = await p.evaluate(id => ({ edit: window.LOEMap.ui.editStep, field: !!document.getElementById(`f-step_${id}_description`), head: (document.querySelector('#coach-body .eyebrow') || {}).textContent }), sIds[0]);
  check('Open on a step row shows its page with the description field', pageOpen.edit === sIds[0] && pageOpen.field && /Step 1\.1 of/.test(pageOpen.head), JSON.stringify(pageOpen));
  await p.selectOption(`#f-step_${sIds[0]}_status`, 'done');
  await p.waitForTimeout(300);
  const done = await p.evaluate(id => { const s = window.LOEMap.model().stepById.get(id); return { status: s.status, done: s.done }; }, sIds[0]);
  check('choosing Done on the step page saves status and the old done flag', done.status === 'done' && done.done === true, JSON.stringify(done));
  await p.fill(`#f-step_${sIds[0]}_description`, 'Radiology and the ED agree the rule and write it down.');
  await p.waitForTimeout(1100);
  const desc = await p.evaluate(id => window.LOEMap.model().stepById.get(id).description, sIds[0]);
  check('the step page description saves', /write it down/.test(desc), desc);
  await p.evaluate(() => window.LOEMap.dispatch('closeEditor'));
  await settle(p);
  const backAt = await p.evaluate(() => ({ edit: window.LOEMap.ui.editStep, step: window.LOEMap.ui.step, focus: document.activeElement && document.activeElement.id }));
  check('Done on the step page returns to question 2 with the cursor in that way\'s Add step box', backAt.edit === null && backAt.step === 2 && backAt.focus === `new-step-${wayId}`, JSON.stringify(backAt));
  const blank = await p.evaluate(id => window.LOEMap.dispatch('updateStep', id, { text: '  ' }), sIds[0]);
  check('a step cannot be blanked', blank === false);
  const sameWay = await p.evaluate(([a, b]) => window.LOEMap.dispatch('updateStep', a, { afterStepId: b }), [sIds[2], sIds[0]]);
  check('a step cannot wait for a step in its own way', sameWay === false);
  // Way 2 gets a step that waits for way 1's second step: it lands one column after it.
  await p.evaluate(async id => { await window.LOEMap.dispatch('addStep', id, 'Adopt standard protocols'); }, way2);
  await p.waitForTimeout(300);
  const t2 = await p.evaluate(id => window.LOEMap.model().stepsByLoe.get(id)[0].id, way2);
  await p.evaluate(async ([a, b]) => { await window.LOEMap.dispatch('updateStep', a, { afterStepId: b }); }, [t2, sIds[1]]);
  await p.waitForTimeout(300);
  const slots = await p.evaluate(([a, b]) => { const M = window.LOEMap.model(); return { wait: M.stepById.get(a).slot, after: M.stepById.get(b).slot, count: M.slotCount }; }, [t2, sIds[1]]);
  check('a step that waits for a step in another way sits in a later column', slots.wait === 2 && slots.after === 1 && slots.count === 3, JSON.stringify(slots));
  const cycle = await p.evaluate(([a, b]) => window.LOEMap.dispatch('updateStep', a, { afterStepId: b }), [sIds[0], t2]);
  check('a hand-off that would form a circle is refused', cycle === false);
  const nums = await p.evaluate(([a, b]) => { const M = window.LOEMap.model(); return [M.stepById.get(a).num, M.stepById.get(b).num]; }, [sIds[1], t2]);
  check('steps are numbered by way and position', nums[0] === '1.2' && nums[1] === '2.1', JSON.stringify(nums));
  await p.evaluate(async id => { await window.LOEMap.dispatch('moveWay', id, -1); }, way2);
  await p.waitForTimeout(400);
  const moved = await p.evaluate(id => { const M = window.LOEMap.model(); return { first: M.loes[0].id === id, num: M.stepById.get(M.loes[0].steps[0].id).num }; }, way2);
  check('moving a way up renumbers it and its steps', moved.first && moved.num === '1.1', JSON.stringify(moved));
  await p.evaluate(async id => { await window.LOEMap.dispatch('moveWay', id, 1); }, way2);
  await p.waitForTimeout(400);
  const selfFeed = await p.evaluate(id => window.LOEMap.dispatch('updateStep', id, { feedsStepId: id }), t2);
  check('a step cannot feed back into itself', selfFeed === false);
  await p.evaluate(async ([a, b]) => { await window.LOEMap.dispatch('updateStep', a, { feedsStepId: b, feedsVerb: 'improves' }); }, [t2, sIds[0]]);
  await p.waitForTimeout(300);
  const feeds = await p.evaluate(id => { const s = window.LOEMap.model().stepById.get(id); return s.feeds && s.feeds.id + '|' + s.feedsVerb; }, t2);
  check('a feedback link saves with its wording and never changes the order', feeds === sIds[0] + '|improves' && (await p.evaluate(id => window.LOEMap.model().stepById.get(id).slot, t2)) === 2, String(feeds));
  await p.evaluate(async id => { await window.LOEMap.dispatch('deleteStep', id); }, sIds[2]);
  await p.waitForTimeout(300);
  const nSteps = await p.evaluate(id => window.LOEMap.model().stepsByLoe.get(id).length, wayId);
  check('removing a step takes it off the list', nSteps === 2, String(nSteps));
  await shot(p, '02a-desktop-ways-steps-light');

  // Sequence view: one box per step, an arrow along each way, a dashed hand-off between ways.
  await p.evaluate(() => window.LOEMap.dispatch('view', 'sequence'));
  await p.waitForTimeout(400);
  const seq = await p.evaluate(() => ({
    boxes: document.querySelectorAll('#map-svg g.lnode.step').length,
    seq: document.querySelectorAll('#map-svg path.link.t-seq').length,
    waits: document.querySelectorAll('#map-svg path.link.t-waits').length,
    labels: [...document.querySelectorAll('#map-svg text.link-lbl')].map(t => t.textContent).sort(),
  }));
  check('sequence view draws a box per step, arrows along the way with an action, and labelled connections', seq.boxes === 3 && seq.seq === 2 && seq.waits === 1 && JSON.stringify(seq.labels) === JSON.stringify(['improves', 'then']), JSON.stringify(seq));
  // The map's "What is the action?" placeholder drops the cursor into that way's essential-action box.
  await p.click(`#map-svg g.lnode[data-key="ph:${way2}:C"]`);
  await p.waitForTimeout(400);
  const toAction = await p.evaluate(() => ({ step: window.LOEMap.ui.step, focus: document.activeElement && document.activeElement.id }));
  check('the action placeholder on the map opens question 2 with the cursor in that way\'s action box', toAction.step === 2 && toAction.focus === `f-loe_${way2}_capability`, JSON.stringify(toAction));
  await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  const xs = await p.evaluate(([a, b]) => { const x = id => Number((document.querySelector(`#map-svg g.lnode[data-key="step:${id}"]`).getAttribute('transform').match(/translate\(([\d.]+)/) || [])[1]); return { wait: x(a), after: x(b) }; }, [t2, sIds[1]]);
  check('the waiting step is drawn in a later column than the step it waits for', xs.wait > xs.after, JSON.stringify(xs));
  // Reordering: drag the first step of way 1 past the second on the map, then put it back from the step page's position menu.
  const b0 = await p.$eval(`#map-svg g.lnode[data-key="step:${sIds[0]}"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; });
  await p.mouse.move(b0.x, b0.y);
  await p.mouse.down();
  await p.waitForTimeout(350);
  await p.mouse.move(b0.x + b0.w * 1.6, b0.y, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  const dragged = await p.evaluate(id => window.LOEMap.model().stepsByLoe.get(id).map(s => s.num + ' ' + s.text), wayId);
  check('dragging a step past the next one on the map reorders the way', dragged[0] === '1.1 Add overnight coverage' && dragged[1] === '1.2 Agree the worklist rule' && !(await p.evaluate(() => window.LOEMap.ui.editStep)), JSON.stringify(dragged));
  // A tap that wobbles a couple of pixels, as fingers do, still opens the step.
  const b1 = await p.$eval(`#map-svg g.lnode[data-key="step:${sIds[1]}"]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await p.mouse.move(b1.x, b1.y);
  await p.mouse.down();
  await p.mouse.move(b1.x + 3, b1.y + 2, { steps: 2 });
  await p.mouse.up();
  await p.waitForTimeout(400);
  check('a slightly wobbly tap on a step still opens its page', (await p.evaluate(() => window.LOEMap.ui.editStep)) === sIds[1]);
  await p.evaluate(() => window.LOEMap.dispatch('closeEditor'));
  await settle(p);
  // A press held past the hold time and released in place is a pick-up, not a tap: nothing opens and nothing moves.
  await p.mouse.move(b1.x, b1.y);
  await p.mouse.down();
  await p.waitForTimeout(350);
  await p.mouse.up();
  await p.waitForTimeout(300);
  const held = await p.evaluate(id => ({ edit: window.LOEMap.ui.editStep, order: window.LOEMap.model().stepsByLoe.get(id).map(s => s.text) }), wayId);
  check('a long press released in place opens nothing and moves nothing', held.edit === null && held.order.join('|') === 'Add overnight coverage|Agree the worklist rule', JSON.stringify(held));
  // A quick press that moves far is neither a tap nor a drag.
  await p.mouse.move(b1.x, b1.y);
  await p.mouse.down();
  await p.mouse.move(b1.x + 200, b1.y, { steps: 4 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  const flick = await p.evaluate(id => ({ edit: window.LOEMap.ui.editStep, order: window.LOEMap.model().stepsByLoe.get(id).map(s => s.text) }), wayId);
  check('a quick flick before the hold neither opens nor moves the step', flick.edit === null && flick.order.join('|') === 'Add overnight coverage|Agree the worklist rule', JSON.stringify(flick));
  // Trackpad two-finger scroll slides the map instead of zooming it.
  const before = await p.evaluate(() => { const m = /translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)\)/.exec(document.getElementById('zoom-root').getAttribute('transform') || ''); return m ? { x: +m[1], y: +m[2], k: +m[3] } : null; });
  await p.mouse.move(b1.x, b1.y + 120);
  await p.mouse.wheel(200, 0);
  await p.waitForTimeout(300);
  const after2 = await p.evaluate(() => { const m = /translate\(([-\d.]+),([-\d.]+)\) scale\(([\d.]+)\)/.exec(document.getElementById('zoom-root').getAttribute('transform') || ''); return m ? { x: +m[1], y: +m[2], k: +m[3] } : null; });
  check('a two-finger scroll slides the map sideways and keeps the zoom', !!before && !!after2 && after2.x < before.x - 50 && Math.abs(after2.k - before.k) < 1e-6, JSON.stringify({ before, after2 }));
  await p.evaluate(() => window.LOEMap.dispatch('fit'));
  await p.waitForTimeout(400);
  await p.evaluate(id => window.LOEMap.dispatch('editStep', id), sIds[0]);
  await settle(p);
  await p.selectOption(`#f-step_${sIds[0]}_position`, '');
  await p.waitForTimeout(500);
  const placed0 = await p.evaluate(id => window.LOEMap.model().stepsByLoe.get(id).map(s => s.num + ' ' + s.text), wayId);
  check('the step page\'s position menu puts a step first again', placed0[0] === '1.1 Agree the worklist rule', JSON.stringify(placed0));
  await p.evaluate(() => window.LOEMap.dispatch('closeEditor'));
  await settle(p);
  await p.evaluate(id => window.LOEMap.dispatch('select', 'step:' + id), t2);
  await settle(p);
  const infoTitle = await p.$eval('#info', el => (el.hidden ? '' : el.querySelector('.info-title').textContent));
  check('selecting a step shows its details bar with its number', /^Step 2\.1 of Technologist throughput/.test(infoTitle), infoTitle);
  await shot(p, '04b-desktop-sequence-light');
  await p.click('#info button[data-cmd="editStep"]');
  await p.waitForTimeout(400);
  const landed = await p.evaluate(id => ({ edit: window.LOEMap.ui.editStep, field: !!document.getElementById(`f-step_${id}_text`) }), t2);
  check('Open step on the details bar opens that step\'s page', landed.edit === t2 && landed.field, JSON.stringify(landed));
  await shot(p, '04c-desktop-step-page-light');
  await p.evaluate(() => { window.LOEMap.dispatch('closeEditor'); window.LOEMap.dispatch('select', null); });
  await settle(p);

  // Question 3: doers, then the team picks the center of gravity itself.
  await p.evaluate(async id => { await window.LOEMap.dispatch('setDoer', id, 'On-duty radiologists'); }, wayId);
  await p.evaluate(async id => { await window.LOEMap.dispatch('updateWay', id, { capability: 'complete and send studies without delay' }); }, way2);
  await p.evaluate(async id => { await window.LOEMap.dispatch('setDoer', id, 'CT technologists'); }, way2);
  await p.waitForTimeout(300);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('naming doers alone does not pick a center of gravity', u[4] === false && (await p.evaluate(() => window.LOEMap.model().cogId)) === null, JSON.stringify(u));
  await p.evaluate(() => window.LOEMap.dispatch('goto', 3));
  await settle(p);
  const radios = await p.$$eval('input[name="cog"]', els => els.length);
  check('question 3 offers each doer as a center-of-gravity choice', radios === 2, String(radios));
  await p.click('#coach-body button[data-cmd="seeSteps"]');
  await p.waitForTimeout(400);
  const seeSteps = await p.evaluate(id => {
    const el = document.getElementById(`way-${id}`), sc = document.getElementById('coach-scroll');
    const r = el && el.getBoundingClientRect(), c = sc.getBoundingClientRect();
    return { step: window.LOEMap.ui.step, focus: document.activeElement && document.activeElement.id, inView: !!r && r.top >= c.top - 2 && r.top < c.top + 80, scrolled: sc.scrollTop };
  }, wayId);
  check('See steps on a doer card opens question 2 at that way\'s card', seeSteps.step === 2 && seeSteps.focus === `way-${wayId}` && seeSteps.inView && seeSteps.scrolled > 0, JSON.stringify(seeSteps));
  await p.evaluate(() => window.LOEMap.dispatch('goto', 3));
  await settle(p);
  await p.click('label.radio:has-text("On-duty radiologists")');
  await p.waitForTimeout(400);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  const cog = await p.evaluate(() => { const M = window.LOEMap.model(); return M.cogId && M.nodes.get(M.cogId).label; });
  check('choosing the center of gravity opens question 4', u[4] === true, JSON.stringify(u));
  check('the chosen doer is the center of gravity', cog === 'On-duty radiologists', cog);
  await shot(p, '02b-desktop-doers-light');
  await p.click('#coach-body button[data-cmd="addWayPrompt"]');
  await p.waitForTimeout(300);
  const back = await p.evaluate(() => ({ step: window.LOEMap.ui.step, focus: document.activeElement && document.activeElement.id, addAboveCards: (() => { const a = document.getElementById('new-way'); const c = document.querySelector('#coach-body .stack .card'); return !!(a && c && (a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)); })() }));
  check('Add a way in question 3 returns to question 2 with the cursor in the add box', back.step === 2 && back.focus === 'new-way', JSON.stringify(back));
  check('question 2 keeps the add box above the way cards', back.addAboveCards, JSON.stringify(back));
  await p.evaluate(() => window.LOEMap.dispatch('goto', 3));
  await settle(p);

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
  const vulnCols = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#coach-body .req-head')];
    const lefts = rows.map(r => Math.round(r.querySelector('.check').getBoundingClientRect().left));
    const xs = rows.map(r => Math.round(r.querySelector('.btn').getBoundingClientRect().left));
    const types = rows.map(r => r.querySelector('.req-type').textContent);
    const labels = rows.map(r => r.querySelector('.btn').textContent);
    return { n: rows.length, lefts, xs, types, labels };
  });
  check('the Vulnerable box sits in the same spot on every need row, whatever the kind of need', vulnCols.n === 2 && new Set(vulnCols.types).size === 2 && new Set(vulnCols.lefts).size === 1 && new Set(vulnCols.xs).size === 1 && vulnCols.labels.every(l => l === 'Delete need'), JSON.stringify(vulnCols));

  // Step 5 and 6
  await p.evaluate(async () => { await window.LOEMap.dispatch('addNode', 'Conference schedule', 'process', ''); });
  await p.waitForTimeout(300);
  const ids = await p.evaluate(() => { const M = window.LOEMap.model(); const f = l => [...M.nodes.values()].find(n => n.label === l).id; return [f('Overnight coverage schedule'), f('Conference schedule')]; });
  await p.evaluate(async ([a, b]) => { await window.LOEMap.dispatch('link', a, 'depends_on', b); }, ids);
  await p.evaluate(async () => { await window.LOEMap.dispatch('reviewLinks', true); });
  await p.waitForTimeout(300);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('marking relationships reviewed opens phases but not the review', u[6] === true && u[7] === false, JSON.stringify(u));
  const dup = await p.evaluate(([a, b]) => window.LOEMap.dispatch('link', a, 'depends_on', b), ids);
  check('duplicate relationship is refused', dup === false);
  const selfNeed = await p.evaluate(async id => window.LOEMap.dispatch('addRequirement', id, 'On-duty radiologists', 'actor'), wayId);
  check('a doer cannot be its own need', selfNeed === false);

  // Renaming a typo onto an existing item's name offers a merge instead of failing quietly.
  await p.evaluate(async () => { await window.LOEMap.dispatch('addNode', 'Conference schedul', 'process', ''); });
  await p.waitForTimeout(300);
  const [typoId, realId, worklistId] = await p.evaluate(() => { const M = window.LOEMap.model(); const f = l => [...M.nodes.values()].find(n => n.label === l).id; return [f('Conference schedul'), f('Conference schedule'), f('Worklist prioritization rule')]; });
  await p.evaluate(async ([a, b]) => { await window.LOEMap.dispatch('link', a, 'influences', b); }, [typoId, worklistId]);
  await p.evaluate(id => window.LOEMap.dispatch('editNode', id), typoId);
  await settle(p);
  await p.fill(`#f-node_${typoId}_label`, 'Conference schedule');
  await p.press(`#f-node_${typoId}_label`, 'Enter');
  await p.waitForTimeout(400);
  const offer = await p.evaluate(id => ({ shown: !!document.querySelector('#coach-body .merge'), box: (document.getElementById(`f-node_${id}_label`) || {}).value }), typoId);
  check('renaming onto an existing name offers a merge and shows the saved name again', offer.shown && offer.box === 'Conference schedul', JSON.stringify(offer));
  await shot(p, '03c-desktop-merge-offer-light');
  await p.click('#coach-body .merge button[data-cmd="mergeNodes"]');
  await p.waitForTimeout(600);
  const merged = await p.evaluate(([real, wl]) => { const M = window.LOEMap.model(); return { count: [...M.nodes.values()].filter(n => n.label.startsWith('Conference schedul')).length, moved: M.links.some(k => k.source === real && k.target === wl && k.type === 'influences'), kept: M.links.some(k => k.target === real && k.type === 'depends_on'), editing: window.LOEMap.ui.editNode }; }, [realId, worklistId]);
  check('merging leaves one item with both sets of links', merged.count === 1 && merged.moved && merged.kept && merged.editing === realId, JSON.stringify(merged));
  await p.evaluate(() => window.LOEMap.dispatch('closeEditor'));

  // Phases: a main effort per phase, set through the form.
  await p.evaluate(() => window.LOEMap.dispatch('goto', 6));
  await settle(p);
  await p.fill('#new-phase', 'Prepare');
  await p.press('#new-phase', 'Enter');
  await p.waitForTimeout(400);
  const phId = await p.evaluate(() => window.LOEMap.model().phases[0] && window.LOEMap.model().phases[0].id);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('a phase without a main effort keeps the tracker and review closed', !!phId && u[7] === false && u[8] === false, JSON.stringify(u));
  await p.selectOption(`#f-phase_${phId}_mainLoeId`, way2);
  await p.waitForTimeout(400);
  u = await p.evaluate(() => window.LOEMap.unlocks());
  check('choosing a main effort for every phase opens the tracker and the review', u[7] === true && u[8] === true, JSON.stringify(u));
  const mainNote = await p.$eval('#coach-body', el => /not your center of gravity/.test(el.textContent));
  check('coach asks what protects the center of gravity when another way leads', mainNote);
  const cogStill = await p.evaluate(() => { const M = window.LOEMap.model(); return M.cogId && M.nodes.get(M.cogId).label; });
  check('the center of gravity does not change with the main effort', cogStill === 'On-duty radiologists', cogStill);
  // Dates typed key by key: the box must not be redrawn mid-entry (a redraw resets it and closes an open calendar).
  const sSel = `#f-phase_${phId}_start`, eSel = `#f-phase_${phId}_end`;
  await p.click(sSel, { position: { x: 14, y: 20 } });
  await p.evaluate(s => { window.__dateEl = document.querySelector(s); }, sSel);
  await p.keyboard.type('01152027', { delay: 40 });
  await p.waitForTimeout(300);
  const typedDate = await p.evaluate(s => ({ value: document.querySelector(s).value, same: document.querySelector(s) === window.__dateEl }), sSel);
  check('typing a start date keeps the box and the whole date', typedDate.value === '2027-01-15' && typedDate.same, JSON.stringify(typedDate));
  await p.click('h2.question');
  await p.waitForTimeout(1100);
  check('a phase has no end box; it ends at the project due date until another phase follows', !(await p.$(eSel)) && /project due date/.test(await p.$eval('#coach-body', el => el.textContent)));
  // A second phase: the first now ends the day before it starts. Same start dates are flagged.
  await p.evaluate(async () => { await window.LOEMap.dispatch('addPhase', 'Launch'); });
  await p.waitForTimeout(300);
  const ph2Id = await p.evaluate(() => window.LOEMap.model().phases.find(x => x.name === 'Launch').id);
  await p.evaluate(async ([id, w]) => { await window.LOEMap.dispatch('updatePhase', id, { start: '2027-03-01', mainLoeId: w }); }, [ph2Id, wayId]);
  await p.waitForTimeout(400);
  const bounds = await p.evaluate(() => window.LOEMap.model().phases.map(x => [x.name, x.start, x.end, x.endsAt]));
  check('the first phase ends the day before the second starts', JSON.stringify(bounds) === JSON.stringify([['Prepare', '2027-01-15', '2027-02-28', 'next'], ['Launch', '2027-03-01', '', 'none']]), JSON.stringify(bounds));
  await p.evaluate(async id => { await window.LOEMap.dispatch('updatePhase', id, { start: '2027-01-15' }); }, ph2Id);
  await p.waitForTimeout(400);
  check('two phases starting on the same date are flagged', await p.$eval('#coach-body', el => /same date as another/.test(el.textContent)));
  await p.evaluate(async id => { await window.LOEMap.dispatch('updatePhase', id, { start: '2027-03-01' }); }, ph2Id);
  await p.waitForTimeout(400);
  await shot(p, '03b-desktop-phases-light');
  // Steps can be placed in phases once phases exist; the review asks about the ones that are not.
  await p.evaluate(() => window.LOEMap.dispatch('goto', 2));
  await settle(p);
  check('once a phase exists, each step offers a phase menu', !!(await p.$(`#f-step_${sIds[0]}_phaseId`)));
  await p.selectOption(`#f-step_${sIds[0]}_phaseId`, phId);
  await p.waitForTimeout(300);
  const placed = await p.evaluate(id => window.LOEMap.model().stepById.get(id).phaseId, sIds[0]);
  check('choosing a phase for a step saves it', placed === phId, String(placed));
  // Track: every step by way, statuses and owners editable in place, blocked and overdue flagged.
  await p.evaluate(() => window.LOEMap.dispatch('goto', 7));
  await settle(p);
  const trackRows = await p.$$eval('#coach-body .track-row .step-num', els => els.map(e => e.textContent));
  check('Track lists every step with its number', JSON.stringify(trackRows) === JSON.stringify(['1.1', '1.2', '2.1']), JSON.stringify(trackRows));
  await p.selectOption(`#f-step_${sIds[1]}_status-tr`, 'blocked');
  await p.waitForTimeout(400);
  const blockedAsk = await p.$eval('#coach-body', el => /What is blocking it/.test(el.textContent));
  check('a blocked step on Track asks what is blocking it', blockedAsk && (await p.evaluate(id => window.LOEMap.model().stepById.get(id).status, sIds[1])) === 'blocked');
  await p.evaluate(async id => { await window.LOEMap.dispatch('updateStep', id, { due: '2020-01-01' }); }, t2);
  await p.waitForTimeout(400);
  check('a past due date on an unfinished step is flagged as overdue', await p.$eval('#coach-body', el => /Was due/.test(el.textContent)) && (await p.evaluate(id => window.LOEMap.model().stepById.get(id).overdue, t2)) === true);
  await p.fill(`#f-loe_${wayId}_now`, 'ED reads sit in the general worklist.');
  await p.waitForTimeout(1100);
  const nowSaved = await p.evaluate(id => window.LOEMap.model().loeById.get(id).now, wayId);
  check('where a way stands now saves from Track', /general worklist/.test(nowSaved), nowSaved);
  await shot(p, '03d-desktop-track-light');
  // Sequence by phase: phase columns with dates, a not-placed column, way.step numbers, the feedback arrow, clickable headers.
  await p.evaluate(() => window.LOEMap.dispatch('view', 'sequence'));
  await p.waitForTimeout(400);
  const seqB = await p.evaluate(() => ({ heads: [...document.querySelectorAll('#map-svg text.col-head')].map(t => t.textContent), feeds: document.querySelectorAll('#map-svg path.link.t-feeds').length, labels: [...document.querySelectorAll('#map-svg text.link-lbl')].map(t => t.textContent).sort(), nums: [...document.querySelectorAll('#map-svg g.lnode.step .snum text')].map(t => t.textContent).sort(), subs: [...document.querySelectorAll('#map-svg text.col-sub')].map(t => t.textContent) }));
  check('sequence by phase shows phase columns, a not-placed column, way.step numbers, and the feedback arrow', JSON.stringify(seqB.heads) === JSON.stringify(['Prepare', 'Launch', 'Not placed yet', 'Essential action', 'Objective']) && seqB.feeds === 1 && JSON.stringify(seqB.labels) === JSON.stringify(['improves', 'then']) && JSON.stringify(seqB.nums) === JSON.stringify(['1.1', '1.2', '2.1']) && /^Jan 15(, 2027 to Feb 28, 2027|–Feb 28)$/.test(seqB.subs[0]), JSON.stringify(seqB));
  await shot(p, '04d-desktop-sequence-phases-light');
  await p.click('#map-svg g.col-btn.is-link text.col-head');
  await p.waitForTimeout(400);
  const hdr = await p.evaluate(() => ({ step: window.LOEMap.ui.step, focus: document.activeElement && document.activeElement.id }));
  check('tapping a phase header opens that phase\'s start date', hdr.step === 6 && hdr.focus === `f-phase_${phId}_start`, JSON.stringify(hdr));
  await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await p.evaluate(() => window.LOEMap.dispatch('goto', 8));
  await settle(p);
  const rvText = await p.$eval('#coach-body', el => el.textContent);
  check('the review lists the numbered steps, where things stand, and the unplaced ones', /1\.1/.test(rvText) && /Agree the worklist rule/.test(rvText) && /not placed yet/.test(rvText) && /general worklist/.test(rvText) && /is blocked/.test(rvText), rvText.slice(0, 80));
  await shot(p, '04-desktop-review-light');

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
  const after = await p.evaluate(() => { const M = window.LOEMap.model(); return { cog: M.cogId, stored: M.P.cogNodeId ?? null, radUses: M.links.filter(k => k.type === 'uses' && k.source === M.loes[0].doerNodeId).length, doer: M.loes[0].doerNodeId ?? null, step: window.LOEMap.ui.step, reach: window.LOEMap.reachable() }; });
  check('deleting the center of gravity clears it, its links, and the doer slot', after.cog === null && after.stored === null && after.doer === null, JSON.stringify(after));
  check('steps already opened stay open after an edit removes a prerequisite', after.reach === 8, JSON.stringify(after));

  // Clearing the whole shared map resets the locks this browser remembered.
  await p.evaluate(() => { window.__stubDb.docs.clear(); window.__stubDb.notify(); });
  await p.waitForTimeout(400);
  const fresh = await p.evaluate(() => ({ max: window.LOEMap.ui.maxReached, reach: window.LOEMap.reachable(), step: window.LOEMap.ui.step, saved: JSON.parse(localStorage.getItem('loe-map-ui-v1') || '{}').maxReached }));
  check('an emptied map locks the later steps again and forgets the saved progress', fresh.max <= 1 && fresh.reach === 1 && fresh.step <= 1 && fresh.saved <= 1, JSON.stringify(fresh));
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
    check(`${label} ${scheme}: worked example opens all steps`, reach === 8, String(reach));
    if (label === 'desktop' && scheme === 'light') {
      const M = await p.evaluate(() => { const M = window.LOEMap.model(); return { cog: M.nodes.get(M.cogId).label, vulns: M.vulns.length, nodes: M.nodes.size, links: M.links.length, steps: M.steps.length, waits: M.steps.filter(s => s.after).length, slots: M.slotCount, described: M.steps.filter(s => s.description).length, feeds: M.steps.filter(s => s.feeds).length, pr: M.progress, ends: M.phases.map(x => x.end) }; });
      check('worked example: center of gravity is the on-duty radiologists', M.cog === 'On-duty radiologists', JSON.stringify(M));
      check('worked example: fourteen steps, two hand-offs, six columns of order', M.steps === 14 && M.waits === 2 && M.slots === 6, JSON.stringify(M));
      check('worked example: every step described, one feedback link, statuses counted', M.described === 14 && M.feeds === 1 && M.pr.done === 3 && M.pr.doing === 2 && M.pr.blocked === 1 && M.pr.unknown === 1, JSON.stringify(M));
      check('worked example: phase ends derive from the next start and the due date', JSON.stringify(M.ends) === JSON.stringify(['2026-11-30', '2027-01-31', '2027-03-31']), JSON.stringify(M.ends));
      const disabled = await p.$$eval('#coach-body input, #coach-body textarea, #coach-body select', els => els.every(e => e.disabled));
      check('worked example is read-only', disabled);
    }
    for (const step of [1, 2, 3, 4, 6, 7]) {
      await p.evaluate(s => window.LOEMap.dispatch('goto', s), step);
      await settle(p);
      const bad = await p.evaluate(() => {
        const out = [];
        const sc = document.getElementById('coach-scroll');
        if (sc.scrollWidth > sc.clientWidth + 1) out.push('coach panel scrolls sideways');
        const rail = document.getElementById('rail');
        if (rail.scrollWidth > rail.clientWidth + 1) out.push('step bar scrolls sideways');
        for (const el of document.querySelectorAll('#coach-body textarea, #coach-body input[type="text"]')) {
          if (el.scrollWidth > el.clientWidth + 1) out.push(el.id + ' scrolls sideways');
          if (el.tagName === 'TEXTAREA' && el.scrollHeight > el.clientHeight + 3) out.push(el.id + ' hides lines');
        }
        return out;
      });
      check(`${label} ${scheme}: ${step === 6 ? 'phases' : step === 7 ? 'track' : 'question ' + step} answers fit with no sideways scrolling`, bad.length === 0, bad.join(', '));
      if (step === 7 && label === 'desktop' && scheme === 'light') {
        const tr = await p.evaluate(() => ({ rows: document.querySelectorAll('#coach-body .track-row').length, dis: [...document.querySelectorAll('#coach-body select')].every(e => e.disabled), blocked: /No budget line/.test(document.getElementById('coach-body').textContent) }));
        check('worked example: Track shows fourteen read-only rows and the blocked reason', tr.rows === 14 && tr.dis && tr.blocked, JSON.stringify(tr));
      }
      if (step === 7 && mobile) await shot(p, `08c-${label}-track-${scheme}`);
      if (mobile && step === 1) await shot(p, `08-${label}-goal-${scheme}`);
      if (mobile && step === 2) await shot(p, `08a-${label}-ways-${scheme}`);
      if (mobile && step === 4) await shot(p, `08d-${label}-needs-${scheme}`);
      if (step === 6) await shot(p, `08b-${label}-phases-${scheme}`);
    }
    if (mobile) {
      await p.evaluate(() => window.LOEMap.dispatch('goto', 0));
      await settle(p);
      for (const [sel, tag] of [['.terms', 'terms'], ['.chain', 'chain'], ['.chain + .ask', 'test']]) {
        await p.$eval('#coach-scroll', (el, s) => { const t = document.querySelector(s); el.scrollTop += t.getBoundingClientRect().top - el.getBoundingClientRect().top - 12; }, sel);
        await shot(p, `09-${label}-intro-${tag}-${scheme}`);
      }
      const introOk = await p.$$eval('.chain .chain-row', rows => rows.length === 5);
      check(`${label} ${scheme}: intro shows the five-part pizza example`, introOk);
      await p.evaluate(() => window.LOEMap.dispatch('goto', 3));
      await settle(p);
      await shot(p, `10-${label}-coach-${scheme}`);
      const fields = await p.$$eval('[contenteditable]', e => e.length);
      check(`${label} ${scheme}: no contenteditable widgets, so keyboard dictation works`, fields === 0);
      await p.tap('#tab-map');
      await settle(p);
      const vis = await p.evaluate(() => ({ coach: getComputedStyle(document.getElementById('coach')).display, map: getComputedStyle(document.getElementById('map')).display }));
      check(`${label} ${scheme}: Map tab shows the map and hides the coach`, vis.coach === 'none' && vis.map !== 'none', JSON.stringify(vis));
      const chipsHidden = await p.$eval('#chips', el => getComputedStyle(el).display === 'none');
      check(`${label} ${scheme}: way filters start tucked behind the Ways button`, chipsHidden);
      await p.tap('#btn-ways');
      await settle(p);
      const chips = await p.$eval('#chips', el => ({ shown: getComputedStyle(el).display !== 'none', sideways: el.scrollWidth > el.clientWidth + 1 }));
      check(`${label} ${scheme}: Ways button opens the filters, and they wrap instead of scrolling sideways`, chips.shown && !chips.sideways, JSON.stringify(chips));
      await shot(p, `10b-${label}-ways-open-${scheme}`);
      await p.tap('#btn-ways');
      await settle(p);
    }
    const views = await p.evaluate(() => ({ v: window.LOEMap.ui.view, btns: [...document.querySelectorAll('#maptools .seg button')].map(b => b.textContent), pressed: document.getElementById('v-sequence').getAttribute('aria-pressed'), focusHidden: document.getElementById('btn-focus').hidden, collapseShown: !document.getElementById('collapse-menu').hidden, keySecs: [...document.querySelectorAll('#key .key-sec')].filter(e => !e.hidden).map(e => e.dataset.views) }));
    check(`${label} ${scheme}: the map starts on Sequence, with Lanes and Network a tap away`, views.v === 'sequence' && JSON.stringify(views.btns) === JSON.stringify(['Sequence', 'Lanes', 'Network']) && views.pressed === 'true' && views.focusHidden && views.collapseShown && JSON.stringify(views.keySecs) === JSON.stringify(['sequence']), JSON.stringify(views));
    await p.evaluate(() => window.LOEMap.dispatch('view', 'lanes'));
    await p.waitForTimeout(400);
    const lanesT = await p.evaluate(() => ({ v: window.LOEMap.ui.view, pressed: document.getElementById('v-lanes').getAttribute('aria-pressed'), focusHidden: document.getElementById('btn-focus').hidden, collapseShown: !document.getElementById('collapse-menu').hidden, keySecs: [...document.querySelectorAll('#key .key-sec')].filter(e => !e.hidden).map(e => e.dataset.views), nodes: document.querySelectorAll('#map-svg g.lnode.node').length }));
    check(`${label} ${scheme}: Lanes view draws the items, shows Focus, and hides the Collapse menu and the step key`, lanesT.v === 'lanes' && lanesT.pressed === 'true' && !lanesT.focusHidden && !lanesT.collapseShown && JSON.stringify(lanesT.keySecs) === JSON.stringify(['lanes network']) && lanesT.nodes > 5, JSON.stringify(lanesT));
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
    await p.evaluate(() => window.LOEMap.dispatch('focus', true));
    await p.waitForTimeout(250);
    await shot(p, `14-${label}-network-focus-${scheme}`);
    await p.evaluate(() => { window.LOEMap.dispatch('focus', false); window.LOEMap.dispatch('view', 'sequence'); });
    await p.waitForTimeout(400);
    await p.evaluate(() => window.LOEMap.dispatch('phase', 'ph2'));
    await p.waitForTimeout(300);
    const lanesNow = await p.evaluate(() => ({ read: document.querySelector('g.lane[data-key="l_read"]').classList.contains('is-main-now'), pacs: document.querySelector('g.lane[data-key="l_pacs"]').classList.contains('is-main-now'), select: document.getElementById('phase-select').value }));
    check(`${label} ${scheme}: choosing the Launch phase highlights its main-effort lane only`, lanesNow.read && !lanesNow.pacs && lanesNow.select === 'ph2', JSON.stringify(lanesNow));
    await p.evaluate(() => { window.LOEMap.dispatch('select', null); window.LOEMap.dispatch('view', 'sequence'); });
    await p.waitForTimeout(400);
    const seqEx = await p.evaluate(() => ({
      boxes: document.querySelectorAll('#map-svg g.lnode.step').length,
      waits: document.querySelectorAll('#map-svg path.link.t-waits').length,
      feeds: document.querySelectorAll('#map-svg path.link.t-feeds').length,
      heads: [...document.querySelectorAll('#map-svg text.col-head')].map(t => t.textContent),
      done: document.querySelectorAll('#map-svg g.lnode.step.st-done').length,
      doing: document.querySelectorAll('#map-svg g.lnode.step.st-doing').length,
      blocked: document.querySelectorAll('#map-svg g.lnode.step.st-blocked').length,
      unknown: document.querySelectorAll('#map-svg g.lnode.step.st-unknown .ubadge').length,
      dots: document.querySelectorAll('#map-svg g.lnode.step.st-doing .gbadge circle.dot').length,
      tint: document.querySelectorAll('#map-svg rect.col-active').length,
      main: document.querySelector('g.lane[data-key="l_read"]').classList.contains('is-main-now'),
    }));
    if (label === 'desktop' && scheme === 'light') {
      const c0 = await p.evaluate(() => ({ small: document.querySelectorAll('#map-svg g.lnode.step.is-collapsed').length, label: document.getElementById('collapse-summary').textContent }));
      check('by default, Done and Not started fold away once any step is under way', c0.small === 10 && c0.label === 'Collapsed: 2', JSON.stringify(c0));
      await p.evaluate(() => window.LOEMap.dispatch('collapse', 'none'));
      await p.waitForTimeout(300);
      await p.evaluate(() => window.LOEMap.dispatch('collapse', 'done'));
      await p.waitForTimeout(300);
      const c1 = await p.evaluate(() => ({ small: document.querySelectorAll('#map-svg g.lnode.step.is-collapsed').length, text: [...document.querySelectorAll('#map-svg g.lnode.step.is-collapsed .nlabel')].length, label: document.getElementById('collapse-summary').textContent }));
      await p.evaluate(() => window.LOEMap.dispatch('collapse', 'all'));
      await p.waitForTimeout(300);
      const c2 = await p.evaluate(() => ({ small: document.querySelectorAll('#map-svg g.lnode.step.is-collapsed').length, width: document.querySelector('#map-svg g.lnode.step.is-collapsed rect.nbox').getAttribute('width'), label: document.getElementById('collapse-summary').textContent, laneH: [...document.querySelectorAll('#map-svg rect.lane-band')].map(r => r.getAttribute('height')) }));
      await shot(p, `11c-${label}-sequence-collapsed-${scheme}`);
      await p.evaluate(() => window.LOEMap.dispatch('collapse', 'none'));
      await p.waitForTimeout(300);
      const c3 = await p.evaluate(() => document.querySelectorAll('#map-svg g.lnode.step.is-collapsed').length);
      await p.click('#collapse-summary'); await p.waitForTimeout(200);
      const m0 = await p.evaluate(() => document.getElementById('collapse-menu').open);
      await p.click('#collapse-statuses button'); await p.waitForTimeout(200);
      const m1 = await p.evaluate(() => document.getElementById('collapse-menu').open);
      await p.click('#v-sequence'); await p.waitForTimeout(200);
      const m2 = await p.evaluate(() => document.getElementById('collapse-menu').open);
      await p.click('#collapse-summary'); await p.waitForTimeout(200);
      await p.keyboard.press('Escape'); await p.waitForTimeout(200);
      const m3 = await p.evaluate(() => document.getElementById('collapse-menu').open);
      await p.evaluate(() => window.LOEMap.dispatch('collapse', 'none')); await p.waitForTimeout(300);
      check('the Collapse menu stays open for its own buttons and closes on a tap outside or Escape', m0 === true && m1 === true && m2 === false && m3 === false, JSON.stringify({ m0, m1, m2, m3 }));
      check('collapsing by status shrinks only those steps; collapsing all shrinks every box; Show everything restores them', c1.small === 3 && c1.text === 0 && c1.label === 'Collapsed: 1' && c2.small === 14 && c2.width === '56' && c2.label === 'Collapsed: all' && c2.laneH.every(h => h === '66') && c3 === 0, JSON.stringify({ c1, c2, c3 }));
    }
    check(`${label} ${scheme}: sequence view has a column per phase, every step, both links, and statuses`, JSON.stringify(seqEx.heads) === JSON.stringify(['Prepare', 'Launch', 'Sustain', 'Essential action', 'Objective']) && seqEx.boxes === 14 && seqEx.waits === 2 && seqEx.feeds === 1 && seqEx.done === 3 && seqEx.doing === 2 && seqEx.blocked === 1 && seqEx.unknown === 1 && seqEx.dots === 6 && seqEx.tint === 1 && seqEx.main, JSON.stringify(seqEx));
    await shot(p, `11b-${label}-sequence-${scheme}`);
    if (mobile) {
      const sbox = await p.evaluate(() => {
        const c = document.getElementById('canvas').getBoundingClientRect();
        for (const g of document.querySelectorAll('#map-svg g.lnode.step')) {
          const r = g.getBoundingClientRect();
          const x = r.x + r.width / 2, y = r.y + r.height / 2;
          if (x > c.left + 10 && x < c.right - 10 && y > c.top + 10 && y < c.bottom - 80) return { x, y };
        }
        return null;
      });
      check(`${label} ${scheme}: a step is visible on the initial phone framing`, !!sbox);
      if (sbox) await p.touchscreen.tap(sbox.x, sbox.y);
      await settle(p);
      const stepInfo = await p.evaluate(() => !!window.LOEMap.ui.editStep && window.LOEMap.ui.tab === 'coach' && /^Step \d+\.\d+ of/.test((document.querySelector('#coach-body .eyebrow') || {}).textContent || ''));
      check(`${label} ${scheme}: tapping a step opens its page in the coach`, stepInfo);
      await shot(p, `12b-${label}-step-page-${scheme}`);
      await p.evaluate(() => { window.LOEMap.dispatch('closeEditor'); window.LOEMap.dispatch('tab', 'map'); });
      await settle(p);
    }
    if (label === 'desktop') {
      await p.click('#key summary');
      await settle(p);
      await shot(p, `13b-${label}-key-${scheme}`);
      await p.click('#key summary');
    }
    await p.evaluate(() => { window.LOEMap.dispatch('tab', 'coach'); window.LOEMap.dispatch('goto', 8); });
    await settle(p);
    await shot(p, `15-${label}-review-${scheme}`);
    await p.$eval('#coach-scroll', el => { const t = document.querySelector('.phase-list'); el.scrollTop += t.getBoundingClientRect().top - el.getBoundingClientRect().top - 60; });
    await shot(p, `16-${label}-review-phases-${scheme}`);
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
  check('a fresh visitor opens on the Sequence view', (await p.evaluate(() => window.LOEMap.ui.view)) === 'sequence');
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

// ---------------------------------------------------------------- 4. Two ways with the same doer keep separate needs
{
  const { ctx, p, errors } = await open({ width: 1200, height: 800 });
  const run = (...a) => p.evaluate(async args => window.LOEMap.dispatch(...args), a);
  const pause = () => p.waitForTimeout(250);
  const needs = () => p.evaluate(() => { const M = window.LOEMap.model(); const out = {}; for (const l of M.loes) out[l.name] = (M.reqsByLoe.get(l.id) || []).map(id => M.nodes.get(id).label).sort(); return out; });
  const idOf = (kind, name) => p.evaluate(([k, n]) => { const M = window.LOEMap.model(); return k === 'way' ? M.loes.find(l => l.name === n).id : [...M.nodes.values()].find(x => x.label === n).id; }, [kind, name]);
  await run('setProject', { objective: 'Standard protocol used in 100% of scans by 2027' }); await pause();
  await run('addWay', 'Education'); await pause();
  await run('addWay', 'Adherence'); await pause();
  const A = await idOf('way', 'Education'), B = await idOf('way', 'Adherence');
  await run('updateWay', A, { capability: 'know when to select the protocol' });
  await run('updateWay', B, { capability: 'execute the protocol as designed' }); await pause();
  await run('setDoer', A, 'Technologists'); await pause();
  await run('setDoer', B, 'Technologists'); await pause();
  await run('addRequirement', A, 'Epic: reason for exam', 'process'); await pause();
  await run('addRequirement', B, 'Protocol itself', 'system'); await pause();
  let n = await needs();
  check('same doer in two ways: each way keeps its own needs', JSON.stringify(n.Education) === '["Epic: reason for exam"]' && JSON.stringify(n.Adherence) === '["Protocol itself"]', JSON.stringify(n));
  await run('addRequirement', B, 'Epic: reason for exam', 'process'); await pause();
  n = await needs();
  check('the same need can be added to a second way', n.Adherence.length === 2 && n.Education.length === 1, JSON.stringify(n));
  const reason = await idOf('node', 'Epic: reason for exam');
  await run('removeNeed', B, reason); await pause();
  n = await needs();
  check('removing a need from one way leaves it in the other', JSON.stringify(n.Education) === '["Epic: reason for exam"]' && JSON.stringify(n.Adherence) === '["Protocol itself"]', JSON.stringify(n));
  // Older links saved without a way.
  await run('addNode', 'Old lane need', 'resource', A);
  await run('addNode', 'Old shared need', 'resource', ''); await pause();
  const tech = await idOf('node', 'Technologists'), laneNeed = await idOf('node', 'Old lane need'), sharedNeed = await idOf('node', 'Old shared need');
  await p.evaluate(([t, a, b]) => Promise.all([
    window.__stubDb.doc(`links/uses__${t}__${a}`).set({ source: t, target: a, type: 'uses' }),
    window.__stubDb.doc(`links/uses__${t}__${b}`).set({ source: t, target: b, type: 'uses' }),
  ]), [tech, laneNeed, sharedNeed]); await pause();
  n = await needs();
  check('an older need in a way\'s lane counts for that way only', n.Education.includes('Old lane need') && !n.Adherence.includes('Old lane need'), JSON.stringify(n));
  check('an older need outside the doer\'s lanes counts for every way of that doer', n.Education.includes('Old shared need') && n.Adherence.includes('Old shared need'), JSON.stringify(n));
  await run('removeNeed', B, sharedNeed); await pause();
  n = await needs();
  check('removing an older shared need from one way keeps it in the other', n.Education.includes('Old shared need') && !n.Adherence.includes('Old shared need'), JSON.stringify(n));
  // Relationships from the item editor can name an item that is not on the map yet.
  await run('editNode', reason); await pause();
  await p.fill('#ed-rel-to', 'Non-radiology clinicians');
  await p.click('#ed-rel-btn'); await p.waitForTimeout(400);
  await p.fill('#ed-rel-to', 'Protocol itself');
  await p.press('#ed-rel-to', 'Enter'); await p.waitForTimeout(400);
  const rel = await p.evaluate(([rid, way]) => {
    const M = window.LOEMap.model();
    const clin = [...M.nodes.values()].find(n => n.label === 'Non-radiology clinicians');
    const proto = [...M.nodes.values()].filter(n => n.label === 'Protocol itself');
    return {
      created: !!clin, lane: clin && clin.loeId === way, type: clin && clin.type,
      linked: !!clin && M.links.some(k => k.source === rid && k.target === clin.id && k.type === 'depends_on'),
      existingReused: proto.length === 1 && M.links.some(k => k.source === rid && k.target === proto[0].id && k.type === 'depends_on'),
      cleared: document.getElementById('ed-rel-to').value === '',
    };
  }, [reason, A]);
  check('a relationship to a new name creates the item in the same way and links it', rel.created && rel.lane && rel.type === 'actor' && rel.linked, JSON.stringify(rel));
  check('a relationship to an existing name links to that item without a copy', rel.existingReused && rel.cleared, JSON.stringify(rel));
  await shot(p, '18-desktop-editor-new-dependency-light');
  await run('closeEditor'); await pause();

  // Relationship wording: pick a verb when adding, then click the row to change it.
  await run('setCog', tech); await pause();
  await run('addRequirement', A, 'Research database', 'system'); await pause();
  await run('reviewLinks', true); await pause();
  await run('goto', 5); await pause();
  const analyst = await idOf('node', 'Non-radiology clinicians'), db = await idOf('node', 'Research database');
  await p.selectOption('#rel-from', analyst);
  await p.selectOption('#rel-type', 'influences|trains');
  await p.fill('#rel-to', 'Research database');
  await p.click('#rel-btn'); await p.waitForTimeout(400);
  let lk = await p.evaluate(([a, b]) => window.LOEMap.model().links.find(k => k.source === a && k.target === b), [analyst, db]);
  check('adding a relationship can use a listed verb', lk && lk.type === 'influences' && lk.verb === 'trains', JSON.stringify(lk));
  const rowText = await p.$eval(`#coach-body button.rel-open[data-args*="${lk.id}"]`, b => b.textContent);
  check('the relationship list shows the chosen wording', /trains/.test(rowText), rowText);
  await p.click(`#coach-body button.rel-open[data-args*="${lk.id}"]`); await p.waitForTimeout(300);
  await p.selectOption('#le-type', 'depends_on|waits on');
  await p.fill('#le-note', 'Until the export is approved');
  await p.click('#coach-body button[data-cmd="saveLink"]'); await p.waitForTimeout(400);
  lk = await p.evaluate(([a, b]) => window.LOEMap.model().links.find(k => k.source === a && k.target === b), [analyst, db]);
  check('editing a relationship changes its kind, wording, and note', lk && lk.type === 'depends_on' && lk.verb === 'waits on' && lk.notes === 'Until the export is approved', JSON.stringify(lk));
  await p.click(`#coach-body button.rel-open[data-args*="${lk.id}"]`); await p.waitForTimeout(300);
  await p.fill('#le-own', 'co-signs');
  await p.click('#coach-body button[data-cmd="saveLink"]'); await p.waitForTimeout(400);
  lk = await p.evaluate(([a, b]) => window.LOEMap.model().links.find(k => k.source === a && k.target === b), [analyst, db]);
  check('own wording replaces the listed verb and keeps the kind', lk && lk.type === 'depends_on' && lk.verb === 'co-signs', JSON.stringify(lk));
  await p.click(`#coach-body button.rel-open[data-args*="${lk.id}"]`); await p.waitForTimeout(300);
  await shot(p, '19-desktop-edit-relationship-light');
  await run('cancelLink'); await pause();
  await run('goto', 4); await pause();
  await shot(p, '17-desktop-shared-doer-needs-light');
  check('shared-doer flow: no errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}`);
process.exit(failed.length ? 1 : 0);
