// Inbound-email webhook adapter: accepts POSTs from an email provider's
// inbound-parse hook and drops the raw message into inbox-drop/ for
// intake.js. Accepts either the raw RFC-822 message as the request body
// (Content-Type: message/rfc822) or JSON {"raw": "..."}.
//
// Auth: requests must carry X-Webhook-Token matching INTAKE_WEBHOOK_TOKEN.
// CLI: node carriers/email-intake/webhook-receiver.js   (PORT env, default 8643)

import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { loadEnv, requireEnv } from '../../lib/config.js';
import { log, warn } from '../../lib/log.js';
import { DROP_DIR } from './intake.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createReceiver({ token, dropDir = DROP_DIR }) {
  mkdirSync(dropDir, { recursive: true });
  return createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end('POST only');
      return;
    }
    if (!tokenMatches(req.headers['x-webhook-token'], token)) {
      warn(`Webhook: rejected request from ${req.socket.remoteAddress} (bad token)`);
      res.writeHead(401).end('unauthorized');
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end('too large');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        let raw = Buffer.concat(chunks);
        if ((req.headers['content-type'] ?? '').includes('application/json')) {
          const parsed = JSON.parse(raw.toString('utf8'));
          if (typeof parsed.raw !== 'string') throw new Error('JSON body must have string "raw"');
          raw = Buffer.from(parsed.raw, 'utf8');
        }
        if (raw.length === 0) throw new Error('empty body');
        const file = join(dropDir, `webhook-${Date.now()}-${randomUUID().slice(0, 8)}.eml`);
        writeFileSync(file, raw);
        log(`Webhook: dropped ${file} (${raw.length} bytes)`);
        res.writeHead(202).end('accepted');
      } catch (err) {
        res.writeHead(400).end(`bad request: ${err.message}`);
      }
    });
  });
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const { INTAKE_WEBHOOK_TOKEN } = requireEnv('INTAKE_WEBHOOK_TOKEN');
  const port = Number(process.env.PORT ?? 8643);
  createReceiver({ token: INTAKE_WEBHOOK_TOKEN }).listen(port, () =>
    log(`Webhook receiver on :${port} — POST raw RFC-822 with X-Webhook-Token. ` +
      'Run `npm run intake` to process drops.')
  );
}
