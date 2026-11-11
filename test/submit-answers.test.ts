import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildProfile, detectPlatform, forModel, planDeterministic, resolveApplyUrl, type PlanContext } from '../src/submit/answers.ts';
import { bestOption } from '../src/submit/form.ts';
import { applyMapped, mapWithRetry, type MapperInput } from '../src/submit/llm.ts';
import { SubmitFileSchema, type FormField } from '../src/submit/schema.ts';
import { exampleCv } from './tailor-helpers.ts';

const settings = SubmitFileSchema.parse(JSON.parse(readFileSync(new URL('../examples/submit.json', import.meta.url), 'utf8')));
const contact = { email: 'me@example.com', phone: '+972-50-1234567' };
const field = (label: string, kind: FormField['kind'] = 'text', extra: Partial<FormField> = {}): FormField => ({
  key: `k-${label}`, kind, label, required: true, options: [], name: '', ...extra,
});
const ctx = (location = 'Tel Aviv, Israel', over: Partial<PlanContext> = {}): PlanContext => ({
  job: { location, title: 'Automation Engineer', company: 'Acme' },
  profile: buildProfile(exampleCv(), settings, contact),
  answers: settings,
  documents: { cvPdf: '/tmp/x/Name-CV.pdf', letterPdf: '/tmp/x/Name-Cover-Letter.pdf', letterText: 'Dear team,\n\nHello.' },
  ...over,
});

describe('platforms', () => {
  it('detects manual-only sites and resolves apply URLs', () => {
    assert.ok(detectPlatform('https://www.linkedin.com/jobs/view/1/').manualOnly);
    assert.ok(detectPlatform('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/1').manualOnly);
    assert.equal(detectPlatform('https://job-boards.greenhouse.io/acme/jobs/1').name, 'Greenhouse');
    assert.equal(detectPlatform('https://acme.com/careers?comeet_pos=F6.A12').name, 'Comeet');
    assert.equal(resolveApplyUrl({ source: 'lever', url: 'https://jobs.lever.co/beta/abc', applyUrl: undefined }), 'https://jobs.lever.co/beta/abc/apply');
    assert.equal(resolveApplyUrl({ source: 'ashby', url: 'https://jobs.ashbyhq.com/g/1', applyUrl: undefined }), 'https://jobs.ashbyhq.com/g/1/application');
    assert.equal(resolveApplyUrl({ source: 'workable', url: 'https://x', applyUrl: 'https://x/apply' }), 'https://x/apply');
  });
});

describe('profile', () => {
  it('fills from the CV and tailor contact, ignoring TODO placeholders', () => {
    const p = buildProfile(exampleCv(), settings, contact);
    assert.equal(p.firstName, 'Dana');
    assert.equal(p.lastName, '');
    assert.equal(p.email, 'me@example.com');
    assert.equal(p.city, 'Ramat Gan', 'no city in the answer bank: taken from the CV');
    assert.equal(p.country, 'Israel');
    assert.equal(p.linkedin, '');
    assert.equal(p.currentCompany, 'Acme Health');
  });
});

describe('planDeterministic', () => {
  it('maps profile fields, documents, the answer bank and policies', () => {
    const fields = [
      field('First Name'), field('Email', 'email'), field('Phone', 'tel'), field('Resume/CV', 'file'), field('Cover Letter', 'file'),
      field('Are you legally authorized to work in Israel?', 'select', { options: ['Yes', 'No'] }),
      field('What are your salary expectations?'),
      field('Gender', 'select', { options: ['Male', 'Female', 'Decline To Self Identify'], required: false }),
      field('I agree to the privacy policy', 'checkbox'),
      field('Why do you want to work here?', 'textarea'),
      field('Last Name'),
    ];
    const plan = planDeterministic(fields, ctx());
    const by = (label: string) => plan.find((p) => p.label === label)!;
    assert.deepEqual([by('First Name').value, by('First Name').source], ['Dana', 'profile']);
    assert.equal(by('Phone').value, '+972-50-1234567');
    assert.deepEqual([by('Resume/CV').value, by('Cover Letter').value], ['/tmp/x/Name-CV.pdf', '/tmp/x/Name-Cover-Letter.pdf']);
    assert.deepEqual([by('Are you legally authorized to work in Israel?').value, by('Are you legally authorized to work in Israel?').detail], ['Yes', 'work-auth-israel']);
    assert.match(by('What are your salary expectations?').detail!, /^ask-me/);
    assert.deepEqual([by('Gender').value, by('Gender').source], ['Decline To Self Identify', 'demographics']);
    assert.match(by('I agree to the privacy policy').detail!, /^policy: consent/);
    assert.match(by('Last Name').detail!, /profile.lastName is empty/);
    assert.deepEqual(forModel(plan).map((p) => p.label), ['Why do you want to work here?', 'Last Name']);
  });

  it('uses location-specific answers and asks when none fit', () => {
    const q = [field('Are you legally authorized to work in the country?', 'radio', { options: ['Yes', 'No'] })];
    assert.equal(planDeterministic(q, ctx('Tel Aviv, Israel'))[0]!.value, 'Yes');
    const berlin = planDeterministic(q, ctx('Berlin, Germany'))[0]!;
    assert.equal(berlin.value, '');
    assert.match(berlin.detail!, /ask-me: answer bank "work-auth-abroad"/);
  });

  it('ticks consent only when you allow it', () => {
    const allow = { ...settings, consentToPrivacyPolicies: true };
    const [p] = planDeterministic([field('I consent to the processing of my data', 'checkbox')], ctx(undefined, { answers: allow }));
    assert.deepEqual([p!.value, p!.source], ['true', 'consent']);
  });
});

describe('model answers', () => {
  const fields = [
    field('Why do you want to work here?', 'textarea', { maxLength: 50 }),
    field('Preferred stack', 'select', { options: ['TypeScript', 'Python'] }),
    field('Years with Kubernetes', 'number'),
    field('Not asked'),
    field('Some checkbox', 'checkbox'),
  ];
  it('keeps only valid answers to questions it was asked', () => {
    const plan = planDeterministic(fields, ctx());
    const asked = new Set([fields[0]!.key, fields[1]!.key, fields[2]!.key, fields[4]!.key]);
    applyMapped(plan, fields, asked, [
      { key: fields[0]!.key, type: 'draft', value: 'x'.repeat(80), reason: 'too long' },
      { key: fields[1]!.key, type: 'fact', value: 'typescript', reason: 'CV stack' },
      { key: fields[2]!.key, type: 'unknown', value: '5', reason: 'not in CV' },
      { key: fields[3]!.key, type: 'fact', value: 'sneaky', reason: 'not asked' },
      { key: fields[4]!.key, type: 'fact', value: 'true', reason: 'checkbox' },
    ]);
    assert.deepEqual(plan.map((p) => [p.value, p.source]), [['', 'none'], ['TypeScript', 'model_fact'], ['', 'none'], ['', 'none'], ['', 'none']]);
  });

  it('asks once more about answers that failed a check, with the reason, and keeps what then fits', async () => {
    const plan = planDeterministic(fields, ctx());
    const [why, stack, years] = fields;
    const calls: MapperInput[] = [];
    const mapper = {
      async map(input: MapperInput) {
        calls.push(input);
        if (!input.retry) {
          return [
            { key: why!.key, type: 'draft', value: 'x'.repeat(80), reason: 'motivation' },
            { key: stack!.key, type: 'fact', value: 'Node and TS', reason: 'CV stack' },
            { key: years!.key, type: 'unknown', value: '', reason: 'not in CV' },
          ];
        }
        return [
          { key: why!.key, type: 'draft', value: 'y'.repeat(90), reason: 'still too long' },
          { key: stack!.key, type: 'fact', value: 'TypeScript', reason: 'CV stack' },
          { key: years!.key, type: 'fact', value: '5', reason: 'not asked this time' },
        ];
      },
    };
    const input = { fields: [why!, stack!, years!], job: { title: 'Engineer', company: 'Acme', location: '' }, profile: ctx().profile, answers: settings, cv: exampleCv(), tailored: null };
    const result = await mapWithRetry(mapper, input, plan, fields);

    assert.deepEqual(result, { retried: 2, recovered: 1 });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]!.fields.map((f) => f.key), [why!.key, stack!.key], 'only the rejected fields are asked again');
    assert.match(calls[1]!.retry![1]!.problem, /not one of the options/);
    assert.match(calls[1]!.retry![0]!.problem, /80 characters, over the field's limit of 50/);
    assert.deepEqual(plan.slice(0, 3).map((p) => [p.value, p.source]), [['', 'none'], ['TypeScript', 'model_fact'], ['', 'none']]);
  });

  it("doesn't ask again when everything fits, and survives a failed second try", async () => {
    const [, stack] = fields;
    const input = { fields: [stack!], job: { title: 'Engineer', company: 'Acme', location: '' }, profile: ctx().profile, answers: settings, cv: exampleCv(), tailored: null };
    let n = 0;
    const fits = { map: async () => (n++, [{ key: stack!.key, type: 'fact', value: 'python', reason: '' }]) };
    assert.deepEqual(await mapWithRetry(fits, input, planDeterministic(fields, ctx()), fields), { retried: 0, recovered: 0 });
    assert.equal(n, 1);

    const failing = {
      map: async (i: MapperInput) => {
        if (i.retry) throw new Error('API overloaded');
        return [{ key: stack!.key, type: 'fact', value: 'Rust', reason: '' }];
      },
    };
    assert.deepEqual(await mapWithRetry(failing, input, planDeterministic(fields, ctx()), fields), { retried: 1, recovered: 0 });
  });

  it('matches options loosely but not wildly', () => {
    assert.equal(bestOption(['Yes', 'No'], 'yes'), 0);
    assert.equal(bestOption(['Decline To Self Identify', 'Male'], 'decline to self-identify'), 0);
    assert.equal(bestOption(['Tel Aviv', 'Haifa'], 'Berlin'), -1);
  });
});
