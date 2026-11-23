#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium, webkit, firefox } = require('playwright');

const EXPECTED_ENDPOINT =
  'https://script.google.com/macros/s/AKfycbxR84v8EDB4bV5icuTFLuRPZn5g0fwYmQd9fm0vPKkOGERLzldZwkV0JTup3UxFX5g/exec';

const repoRoot = path.resolve(__dirname, '..');

// Mirror of the reader (questionnaire_answers.py): format v2 puts the choices in suggested_fix, the free texts in
// issue_text after its first line, and the email in reporter_email.
const TF_KEYS = ['Claude (chat)', 'Claude Code', 'ChatGPT / Codex', 'Gemini', 'GitHub Copilot', 'Local models'];
const FREQ = ['never', 'sometimes', 'weekly', 'daily'];
const HE = ['let an agent edit files in a repository', 'run several agents in parallel or sub-agents',
  'written an instruction file for an agent (CLAUDE.md, AGENTS.md)', 'used AI for literature search',
  'used AI for computations or code', 'used AI for proofs', 'used AI for writing',
  'had an agent suggest a research idea you kept'];
function decodeV2(payload) {
  const fix = JSON.parse(payload.suggested_fix);
  assert.equal(fix.v, 2, 'payload format v2');
  const c = fix.s;
  const nl = payload.issue_text.indexOf('\n');
  const free = JSON.parse(payload.issue_text.slice(nl + 1));
  const tf = {};
  TF_KEYS.forEach((k, i) => { tf[k] = FREQ[+c.tf[i]]; });
  tf.other = {name: c.to, frequency: FREQ[+c.tf[6]]};
  return {
    fix,
    answers: {
      name: payload.reporter_name, email: payload.reporter_email, github_username: fix.gh || null,
      no_github_yet: !!fix.ng, gitlab: c.gl,
      ready_check: {git: c.rc[0], local_latex_editor: c.rc[1], claude_code_installed: c.rc[2],
                    anthropic_account_with_claude_code: c.rc[3]},
      claude_plan: c.pl, research_tools_frequency: tf, where_used_most: c.wm,
      have_you_ever: c.he.split('').map(i => HE[+i]), wrong_math_result: free.w, last_time_helped: free.h,
      pull_or_merge_requests: c.pr, change_how_i_do_mathematics_1_to_5: c.cs, main_concern: c.mc,
      main_concern_other: c.mo, leave_wednesday_with: free.l,
    },
  };
}
const htmlPath = path.join(repoRoot, "docs", "index.html");
const fileUrl = pathToFileURL(htmlPath).href;

const siblingScratch = path.resolve(repoRoot, '..', 'scratch');
const scratchDir =
  process.env.SCRATCH_DIR ||
  (fs.existsSync(siblingScratch)
    ? siblingScratch
    : path.join(os.tmpdir(), 'workshop-questionnaire-screenshots'));

fs.mkdirSync(scratchDir, { recursive: true });

const VIEWPORTS = [
  { width: 375, height: 800, tag: '375x800' },
  { width: 1280, height: 900, tag: '1280x900' },
];

const BROWSERS = [
  { name: 'chromium', engine: chromium },
  { name: 'webkit', engine: webkit },
  { name: 'firefox', engine: firefox },
];

async function runSingleCase(browserName, browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });

  await context.route('http://**', route => route.abort());
  await context.route('https://**', route => route.abort());

  await context.addInitScript(() => {
    window.__sentRequests = [];
    window.__sawDisabledWhileSending = false;
    window.fetch = async function stubbedFetch(url, options) {
      const btn = document.getElementById('submit-btn');
      if (btn && btn.disabled) {
        window.__sawDisabledWhileSending = true;
      }
      window.__sentRequests.push({
        url: String(url),
        method: options && options.method ? options.method : 'GET',
        headers: options && options.headers ? options.headers : {},
        body: options && options.body ? String(options.body) : '',
      });
      await new Promise(resolve => setTimeout(resolve, 40));
      return {
        ok: true,
        status: 200,
        async json() {
          return { status: 'ok', correction_id: 'stub-correction-001' };
        },
      };
    };
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.goto(fileUrl, { waitUntil: 'load' });

  const metaChecks = await page.evaluate(() => ({
    noindex: !!document.querySelector('meta[name="robots"][content="noindex"]'),
    darkreaderLock: !!document.querySelector('meta[name="darkreader-lock"]'),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }));
  assert.equal(metaChecks.noindex, true, `${browserName} ${viewport.tag}: missing noindex meta`);
  assert.equal(metaChecks.darkreaderLock, true, `${browserName} ${viewport.tag}: missing darkreader-lock meta`);
  assert.equal(metaChecks.overflowX, false, `${browserName} ${viewport.tag}: horizontal overflow detected`);

  // 1. Negative control: empty name must show a visible error and send nothing
  await page.click('#submit-btn');
  const emptyNameState = await page.evaluate(() => {
    const msg = document.getElementById('msg');
    const done = document.getElementById('done');
    return {
      msgVisible: getComputedStyle(msg).display !== 'none' && msg.textContent.trim().length > 0,
      msgText: msg.textContent.trim(),
      doneVisible: getComputedStyle(done).display !== 'none',
      sentCount: window.__sentRequests.length,
    };
  });
  assert.equal(emptyNameState.msgVisible, true, `${browserName} ${viewport.tag}: expected error message when name is empty`);
  assert.equal(emptyNameState.doneVisible, false, `${browserName} ${viewport.tag}: confirmation must remain hidden on error`);
  assert.equal(emptyNameState.sentCount, 0, `${browserName} ${viewport.tag}: nothing must be sent when name is empty`);

  // 2. Fill every required field and optional fields
  await page.fill('#q-name', 'Dr. Clara Ejemplo');
  await page.fill('#q-github', 'clara-mpicbg');
  await page.fill('#q-email', 'not-an-email');

  await page.check('input[name="gitlab"][value="yes, the institute\'s"]');
  await page.check('input[name="ready_git"][value="yes"]');
  await page.check('input[name="ready_latex"][value="yes"]');
  await page.check('input[name="ready_claude_code"][value="not yet"]');
  await page.check('input[name="ready_anthropic_account"][value="I\'d like help"]');
  await page.check('input[name="claude_plan"][value="Pro"]');

  await page.check('input[name="freq_row_1"][value="weekly"]');
  await page.check('input[name="freq_row_2"][value="never"]');
  await page.check('input[name="freq_row_3"][value="sometimes"]');
  await page.check('input[name="freq_row_4"][value="never"]');
  await page.check('input[name="freq_row_5"][value="daily"]');
  await page.check('input[name="freq_row_6"][value="sometimes"]');
  await page.fill('#q-tool-other', 'Lean Copilot');
  await page.check('input[name="freq_row_7"][value="sometimes"]');

  await page.check('input[name="where_most"][value="inside an editor"]');
  await page.check('input[name="have_ever"][value="used AI for literature search"]');
  await page.check('input[name="have_ever"][value="used AI for computations or code"]');
  await page.check('input[name="have_ever"][value="used AI for writing"]');

  await page.fill('#q-wrong', 'Yes: a sign error in an Euler characteristic count, caught on a small triangulation.');
  await page.fill('#q-helped', 'It wrote a clean enumeration script for small simplicial complexes in ten minutes.');
  await page.check('input[name="pull_requests"][value="used them"]');

  await page.check('input[name="change_scale"][value="4"]');
  await page.check('input[name="main_concern"][value="checking results"]');
  await page.fill('#q-leave-with', 'A practical verification checklist I can reuse with postdocs.');

  // negative control: an invalid email shows an error and sends nothing
  await page.click('#submit-btn');
  const badEmail = await page.evaluate(() => ({
    msgVisible: getComputedStyle(document.getElementById('msg')).display !== 'none',
    sentCount: window.__sentRequests.length,
  }));
  assert.equal(badEmail.msgVisible, true, `${browserName} ${viewport.tag}: expected error on invalid email`);
  assert.equal(badEmail.sentCount, 0, `${browserName} ${viewport.tag}: nothing must be sent with an invalid email`);
  await page.fill('#q-email', 'clara@example.org');

  const filledShot = path.join(scratchDir, `questionnaire-${browserName}-${viewport.tag}-filled.png`);
  await page.screenshot({ path: filledShot, fullPage: true });

  await page.click('#submit-btn');
  await page.waitForSelector('#done', { state: 'visible', timeout: 5000 });

  const doneShot = path.join(scratchDir, `questionnaire-${browserName}-${viewport.tag}-done.png`);
  await page.screenshot({ path: doneShot, fullPage: true });

  const postSubmit = await page.evaluate(() => ({
    sawDisabled: window.__sawDisabledWhileSending,
    requests: window.__sentRequests,
    doneText: document.getElementById('done').textContent.trim(),
    overflowAfter: document.documentElement.scrollWidth > window.innerWidth,
  }));

  assert.equal(postSubmit.sawDisabled, true, `${browserName} ${viewport.tag}: submit button must be disabled while sending`);
  assert.equal(postSubmit.overflowAfter, false, `${browserName} ${viewport.tag}: horizontal overflow on confirmation screen`);
  assert.ok(postSubmit.doneText.includes('Thank you'), `${browserName} ${viewport.tag}: confirmation text missing`);
  assert.equal(postSubmit.requests.length, 1, `${browserName} ${viewport.tag}: expected exactly 1 stubbed POST`);

  const req = postSubmit.requests[0];
  assert.equal(req.url, EXPECTED_ENDPOINT, `${browserName} ${viewport.tag}: unexpected endpoint URL`);
  assert.equal(req.method, 'POST', `${browserName} ${viewport.tag}: expected POST method`);

  const payload = JSON.parse(req.body);
  assert.equal(payload.action, 'submitCorrection');
  assert.equal(payload.url, '/ai-math-workshop-questionnaire/');
  assert.equal(payload.reporter_name, 'Dr. Clara Ejemplo');
  assert.ok(payload.issue_text.startsWith('Questionnaire · clara-mpicbg\n'), 'issue_text head');
  assert.ok(payload.issue_text.length <= 1000, 'issue_text within the intake cap');
  assert.ok(payload.suggested_fix.length <= 1000, 'suggested_fix within the intake cap');
  assert.equal(payload.reporter_email, 'clara@example.org');

  const {fix, answers} = decodeV2(payload);
  assert.equal(fix.n, 1);
  assert.equal(fix.mot, 'GitHub: clara-mpicbg');
  assert.equal(answers.email, 'clara@example.org');
  assert.equal(answers.name, 'Dr. Clara Ejemplo');
  assert.equal(answers.github_username, 'clara-mpicbg');
  assert.equal(answers.no_github_yet, false);
  assert.equal(answers.gitlab, "yes, the institute's");
  assert.equal(answers.ready_check.git, 'yes');
  assert.equal(answers.ready_check.local_latex_editor, 'yes');
  assert.equal(answers.ready_check.claude_code_installed, 'not yet');
  assert.equal(answers.ready_check.anthropic_account_with_claude_code, "I'd like help");
  assert.equal(answers.claude_plan, 'Pro');
  assert.equal(answers.research_tools_frequency['Claude (chat)'], 'weekly');
  assert.equal(answers.research_tools_frequency['Claude Code'], 'never');
  assert.equal(answers.research_tools_frequency['ChatGPT / Codex'], 'sometimes');
  assert.equal(answers.research_tools_frequency['GitHub Copilot'], 'daily');
  assert.equal(answers.research_tools_frequency['Local models'], 'sometimes');
  assert.equal(answers.research_tools_frequency.other.name, 'Lean Copilot');
  assert.equal(answers.research_tools_frequency.other.frequency, 'sometimes');
  assert.equal(answers.where_used_most, 'inside an editor');
  assert.deepEqual(answers.have_you_ever, [
    'used AI for literature search',
    'used AI for computations or code',
    'used AI for writing',
  ]);
  assert.ok(answers.wrong_math_result.includes('Euler characteristic'));
  assert.ok(answers.last_time_helped.includes('simplicial complexes'));
  assert.equal(answers.pull_or_merge_requests, 'used them');
  assert.equal(answers.change_how_i_do_mathematics_1_to_5, '4');
  assert.equal(answers.main_concern, 'checking results');
  assert.ok(answers.leave_wednesday_with.includes('verification checklist'));

  assert.equal(pageErrors.length, 0, `${browserName} ${viewport.tag}: page errors: ${pageErrors.join('; ')}`);

  await context.close();
  console.log(`PASS questionnaire [${browserName} @ ${viewport.tag}] -> screenshots saved in ${scratchDir}`);
}

async function runFailureRecoveryCheck(browser) {
  const context = await browser.newContext({ viewport: { width: 800, height: 800 } });
  await context.route('https://**', route => route.abort());
  await context.addInitScript(() => {
    window.fetch = async function failingFetch() {
      throw new Error('Simulated network failure');
    };
  });
  const page = await context.newPage();
  await page.goto(fileUrl, { waitUntil: 'load' });
  await page.fill('#q-name', 'Dr. Clara Ejemplo');
  await page.fill('#q-email', 'clara@example.org');
  await page.check('#q-no-github');
  await page.check('input[name="gitlab"][value="no"]');
  await page.check('input[name="ready_git"][value="yes"]');
  await page.check('input[name="ready_latex"][value="yes"]');
  await page.check('input[name="ready_claude_code"][value="yes"]');
  await page.check('input[name="ready_anthropic_account"][value="yes"]');
  await page.check('input[name="claude_plan"][value="Max"]');
  for (let i = 1; i <= 6; i++) {
    await page.check(`input[name="freq_row_${i}"][value="never"]`);
  }
  await page.check('input[name="where_most"][value="not yet"]');
  await page.fill('#q-wrong', 'Not yet.');
  await page.fill('#q-helped', 'None yet.');
  await page.check('input[name="pull_requests"][value="never used"]');
  await page.click('#submit-btn');

  await page.waitForSelector('#msg', { state: 'visible', timeout: 5000 });
  const state = await page.evaluate(() => ({
    btnDisabled: document.getElementById('submit-btn').disabled,
    msgText: document.getElementById('msg').textContent.trim(),
    doneVisible: getComputedStyle(document.getElementById('done')).display !== 'none',
  }));
  assert.equal(state.btnDisabled, false, 'Submit button must re-enable after failed send');
  assert.ok(state.msgText.includes('Connection failed'), 'Expected clear failure message');
  assert.equal(state.doneVisible, false, 'Confirmation must stay hidden after failed send');
  await context.close();
  console.log('PASS questionnaire [network error recovery + no-github-yet toggle]');
}

// Negative control for the intake's 1000-character caps: overlong free texts (pasted past maxlength), every
// checkbox ticked and long names still give fields within the caps, with nothing structured lost.
async function runOverlongCheck(browser) {
  const context = await browser.newContext({ viewport: { width: 800, height: 800 } });
  await context.route('https://**', route => route.abort());
  await context.addInitScript(() => {
    window.__sent = [];
    window.fetch = async function stub(url, opts) {
      window.__sent.push(opts.body);
      return { json: async () => ({ status: 'ok', correction_id: 'c-test' }) };
    };
  });
  const page = await context.newPage();
  await page.goto(fileUrl, { waitUntil: 'load' });
  await page.fill('#q-name', 'A'.repeat(90));
  await page.fill('#q-email', 'long.name@example.org');
  await page.fill('#q-github', 'x'.repeat(39));
  await page.check('input[name="gitlab"][value="no"]');
  for (const n of ['ready_git', 'ready_latex', 'ready_claude_code', 'ready_anthropic_account']) {
    await page.check(`input[name="${n}"][value="I'd like help"]`);
  }
  await page.check('input[name="claude_plan"][value="Team or Enterprise through the institute"]');
  for (let i = 1; i <= 7; i++) await page.check(`input[name="freq_row_${i}"][value="daily"]`);
  await page.check('input[name="where_most"][value="not yet"]');
  for (const box of await page.$$('input[name="have_ever"]')) await box.check();
  await page.check('input[name="pull_requests"][value="use them daily"]');
  await page.check('input[name="main_concern"][value="other"]');
  await page.evaluate(() => {
    const long = ('é"' + String.fromCharCode(92)).repeat(400);
    for (const id of ['q-wrong', 'q-helped', 'q-leave-with', 'q-tool-other', 'q-concern-other']) {
      document.getElementById(id).value = long;
    }
  });
  await page.click('#submit-btn');
  await page.waitForSelector('#done', { state: 'visible', timeout: 5000 });
  const body = JSON.parse((await page.evaluate(() => window.__sent))[0]);
  assert.ok(body.issue_text.length <= 1000, `issue_text ${body.issue_text.length} > 1000`);
  assert.ok(body.suggested_fix.length <= 1000, `suggested_fix ${body.suggested_fix.length} > 1000`);
  const { answers } = decodeV2(body);
  assert.equal(answers.have_you_ever.length, 8, 'all eight ticks kept');
  assert.equal(answers.research_tools_frequency.other.frequency, 'daily');
  assert.equal(answers.email, 'long.name@example.org');
  assert.equal(answers.main_concern, 'other');
  await context.close();
  console.log('PASS questionnaire [overlong answers stay within the intake caps]');
}

(async () => {
  for (const { name, engine } of BROWSERS) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const vp of VIEWPORTS) {
        await runSingleCase(name, browser, vp);
      }
      if (name === 'chromium') {
        await runFailureRecoveryCheck(browser);
        await runOverlongCheck(browser);
      }
    } finally {
      await browser.close();
    }
  }
  console.log('All questionnaire browser checks PASSED.');
})().catch(err => {
  console.error('Questionnaire test suite FAILED:', err);
  process.exit(1);
});
