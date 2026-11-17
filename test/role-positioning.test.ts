import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { positioningBrief, rolePositioning } from '../src/tailor/llm.ts';

describe('what a posting title asks the CV to lead with', () => {
  it('AI automation titles keep the AI automation framing, even when they say Engineer', () => {
    for (const title of [
      'AI Automation Specialist', 'AI Automation Engineer', 'Automation Developer (WhatsApp, Chatbots)', 'Conversational AI Developer',
      'LLM Application Engineer', 'AI Agent Developer', 'Solutions Engineer, Conversational AI', 'n8n Automation Expert', 'Gen AI Engineer',
      'מפתח/ת אוטומציה', 'מפתח/ת בוטים', 'מומחה/ית בינה מלאכותית',
    ]) assert.equal(rolePositioning(title), 'ai-automation', title);
  });

  it('only plain engineering titles get the software engineer framing', () => {
    for (const title of ['Software Engineer', 'Senior Backend Developer', 'Full Stack Developer', 'Integration Engineer', 'Backend Engineer (Node.js)', 'מפתח/ת Full Stack', 'מהנדס/ת תוכנה'])
      assert.equal(rolePositioning(title), 'engineering', title);
  });

  it('anything else is presented for its own title', () => {
    for (const title of ['Implementation Specialist', 'Customer Success Manager', 'Technical Account Manager']) assert.equal(rolePositioning(title), 'as-posted', title);
    // Words that only contain the short ones don't count: "maintenance", "email", "bottle".
    assert.equal(rolePositioning('Maintenance Coordinator'), 'as-posted');
  });

  it('the brief says so to the writer, in words', () => {
    assert.match(positioningBrief('AI Automation Specialist'), /^Role positioning: an AI automation role \("AI Automation Specialist"\)\. .*Do not reframe the candidate as a general software engineer\.$/);
    assert.match(positioningBrief('Software Engineer'), /^Role positioning: a software engineering role \("Software Engineer"\)\. Present the candidate as a software engineer/);
    assert.match(positioningBrief('Implementation Specialist'), /^Role positioning: present the candidate for this posting's own title \("Implementation Specialist"\)/);
  });
});
