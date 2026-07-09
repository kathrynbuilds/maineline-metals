import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttp } from '../lib/http.js';
import { createClaudeClient, RECORD_TOOL, DEFAULT_MODEL } from '../carriers/email-intake/claude-client.js';

test('classifyAndExtract forces the record tool and parses the tool_use block', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          content: [
            { type: 'text', text: 'thinking...' },
            {
              type: 'tool_use',
              name: RECORD_TOOL.name,
              input: {
                classification: 'interested',
                summary: 'Yes with rate.',
                extracted: { rate_range: '$2.60/mi' },
              },
            },
          ],
        }),
    };
  };
  const claude = createClaudeClient({
    apiKey: 'sk-test',
    http: createHttp({ fetchImpl, sleep: async () => {} }),
  });
  const result = await claude.classifyAndExtract({
    from: 'a@b.example',
    subject: 'Re: setup',
    text: 'yes, 2.60/mi',
  });
  assert.equal(result.classification, 'interested');
  assert.equal(result.extracted.rate_range, '$2.60/mi');

  const [req] = requests;
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.options.headers['x-api-key'], 'sk-test');
  const body = JSON.parse(req.options.body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'record_carrier_reply' });
  assert.equal(body.tools[0].name, 'record_carrier_reply');
  assert.match(body.messages[0].content, /yes, 2\.60\/mi/);
});

test('a response without tool_use or with a bogus classification is rejected', async () => {
  const respond = (content) => async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ content }),
  });
  const make = (fetchImpl) =>
    createClaudeClient({ apiKey: 'sk-test', http: createHttp({ fetchImpl, sleep: async () => {} }) });

  await assert.rejects(
    () => make(respond([{ type: 'text', text: 'no tool' }])).classifyAndExtract({ from: 'a', subject: 's', text: 't' }),
    /no tool_use block/
  );
  await assert.rejects(
    () =>
      make(
        respond([{ type: 'tool_use', input: { classification: 'spam', summary: '', extracted: {} } }])
      ).classifyAndExtract({ from: 'a', subject: 's', text: 't' }),
    /Unexpected classification/
  );
});
