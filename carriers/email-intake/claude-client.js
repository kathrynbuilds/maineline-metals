// Direct Claude Messages API client (no SDK — zero-dependency repo).
// Classification + extraction happen in one call with a forced tool so the
// output is always schema-shaped JSON.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttp } from '../../lib/http.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
export const DEFAULT_MODEL = 'claude-sonnet-5';

const SYSTEM_PROMPT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'intake-system.txt'),
  'utf8'
);

export const CLASSIFICATIONS = ['interested', 'declined', 'questions', 'out_of_office', 'other'];

// Enum values mirror the Airtable single-select choices exactly so intake can
// write them without typecasting surprises (see carriers/schema.js).
const YES_NO_UNKNOWN = ['Yes', 'No', 'Unknown'];

export const RECORD_TOOL = {
  name: 'record_carrier_reply',
  description: 'Record the classification and extracted intake answers for one carrier email.',
  input_schema: {
    type: 'object',
    properties: {
      classification: { type: 'string', enum: CLASSIFICATIONS },
      summary: { type: 'string', description: '1-2 factual sentences for the CRM log.' },
      extracted: {
        type: 'object',
        properties: {
          trailer_types: {
            type: 'array',
            items: {
              type: 'string',
              enum: ["Flatbed 48'", "Flatbed 53'", 'Step Deck', 'Conestoga', 'Curtainside', 'Other'],
            },
          },
          coil_racks: { type: 'string', enum: YES_NO_UNKNOWN },
          tarp_sizes: { type: 'array', items: { type: 'string' }, description: "e.g. 4' drop, 6' drop, steel tarps" },
          securement_per_truck: { type: 'string', description: 'chains/straps per truck as stated' },
          capable_48k_coils: { type: 'string', enum: YES_NO_UNKNOWN },
          cargo_insurance_limit_usd: { type: 'number' },
          new_mc_acceptance: {
            type: 'string',
            enum: ['Yes', 'No', 'After 3 Months', 'After 6 Months', 'Case by Case'],
          },
          payment_preference: { type: 'string', enum: ['Standard Terms', 'Quick Pay', 'Factoring'] },
          factoring_company: { type: 'string' },
          rate_range: { type: 'string', description: 'as stated, e.g. "$2.40-2.80/mi Blytheville->ATL"' },
          core_lanes: { type: 'string' },
          trucks_available_per_week: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    required: ['classification', 'summary', 'extracted'],
    additionalProperties: false,
  },
};

export function createClaudeClient({
  apiKey,
  model = DEFAULT_MODEL,
  http = createHttp({ minIntervalMs: 300 }),
} = {}) {
  if (!apiKey) throw new Error('createClaudeClient: apiKey is required');

  return {
    async classifyAndExtract({ from, subject, text }) {
      const body = await http.requestJson(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: [RECORD_TOOL],
          tool_choice: { type: 'tool', name: RECORD_TOOL.name },
          messages: [
            {
              role: 'user',
              content:
                `From: ${from}\nSubject: ${subject}\n\n` +
                `Email body:\n"""\n${text.slice(0, 8000)}\n"""`,
            },
          ],
        }),
      });
      const toolUse = (body.content ?? []).find((b) => b.type === 'tool_use');
      if (!toolUse) throw new Error('Claude response contained no tool_use block');
      const { classification, summary, extracted } = toolUse.input;
      if (!CLASSIFICATIONS.includes(classification)) {
        throw new Error(`Unexpected classification "${classification}"`);
      }
      return { classification, summary: summary ?? '', extracted: extracted ?? {} };
    },
  };
}
