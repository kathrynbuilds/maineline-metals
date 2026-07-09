// Minimal IMAP4rev1 poller (hand-rolled over node:tls — zero-dependency).
// Fetches UNSEEN messages from the outreach inbox and drops each one as a raw
// .eml file into inbox-drop/ for intake.js to consume. It only ever READS
// mail; the \Seen flag set by FETCH is the only mailbox mutation.
//
// Env: IMAP_HOST, IMAP_PORT (993), IMAP_USER, IMAP_PASSWORD, IMAP_MAILBOX (INBOX)
// CLI: node carriers/email-intake/imap-poller.js [--once]

import { connect as tlsConnect } from 'node:tls';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, requireEnv } from '../../lib/config.js';
import { log, warn } from '../../lib/log.js';
import { DROP_DIR } from './intake.js';

function createImapConnection({ host, port, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host }, () => {});
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('IMAP socket timeout')));

    let buffer = Buffer.alloc(0);
    let tagCounter = 0;
    let pending = null; // { tag, resolve, reject, lines }
    let greeted = false;
    let greetResolve;
    const greeting = new Promise((r) => (greetResolve = r));

    const pump = () => {
      // IMAP responses are line-based EXCEPT literals: "{123}\r\n" is
      // followed by exactly 123 raw bytes. Track that while splitting.
      for (;;) {
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.subarray(0, nl).toString('latin1');
        const literalMatch = line.match(/\{(\d+)\}$/);
        if (literalMatch) {
          const size = Number(literalMatch[1]);
          const needed = nl + 2 + size;
          if (buffer.length < needed) return; // wait for the full literal
          const literal = buffer.subarray(nl + 2, needed);
          buffer = buffer.subarray(needed);
          pending?.lines.push({ line, literal });
          continue;
        }
        buffer = buffer.subarray(nl + 2);
        if (!greeted) {
          greeted = true;
          greetResolve(line);
          continue;
        }
        if (pending && line.startsWith(`${pending.tag} `)) {
          const p = pending;
          pending = null;
          if (line.includes('OK')) p.resolve({ status: line, lines: p.lines });
          else p.reject(new Error(`IMAP ${p.tag} failed: ${line}`));
        } else {
          pending?.lines.push({ line, literal: null });
        }
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', (err) => {
      pending?.reject(err);
      reject(err);
    });

    const command = (cmd, { redact = false } = {}) => {
      const tag = `A${String(++tagCounter).padStart(3, '0')}`;
      if (!redact) log(`IMAP > ${cmd}`);
      return new Promise((res, rej) => {
        pending = { tag, resolve: res, reject: rej, lines: [] };
        socket.write(`${tag} ${cmd}\r\n`);
      });
    };

    greeting.then(() => resolve({ command, end: () => socket.end() }));
  });
}

export async function pollOnce({ host, port, user, password, mailbox, dropDir = DROP_DIR }) {
  mkdirSync(dropDir, { recursive: true });
  const imap = await createImapConnection({ host, port });
  try {
    await imap.command(
      `LOGIN "${user.replace(/"/g, '\\"')}" "${password.replace(/"/g, '\\"')}"`,
      { redact: true }
    );
    await imap.command(`SELECT "${mailbox}"`);
    const search = await imap.command('SEARCH UNSEEN');
    const searchLine = search.lines.find((l) => l.line.startsWith('* SEARCH'));
    const ids = (searchLine?.line ?? '').split(/\s+/).filter((t) => /^\d+$/.test(t));
    if (ids.length === 0) {
      log('IMAP: no unseen messages.');
      return 0;
    }
    let saved = 0;
    for (const id of ids) {
      const fetched = await imap.command(`FETCH ${id} (BODY[])`);
      const withLiteral = fetched.lines.find((l) => l.literal);
      if (!withLiteral) {
        warn(`IMAP: FETCH ${id} returned no literal body; skipping.`);
        continue;
      }
      const file = join(dropDir, `imap-${Date.now()}-${id}.eml`);
      writeFileSync(file, withLiteral.literal);
      log(`IMAP: saved message ${id} -> ${file}`);
      saved += 1;
    }
    return saved;
  } finally {
    try {
      await imap.command('LOGOUT');
    } catch {
      // connection may already be closing
    }
    imap.end();
  }
}

const isMain = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  loadEnv();
  const { IMAP_HOST, IMAP_USER, IMAP_PASSWORD } = requireEnv(
    'IMAP_HOST',
    'IMAP_USER',
    'IMAP_PASSWORD'
  );
  const saved = await pollOnce({
    host: IMAP_HOST,
    port: Number(process.env.IMAP_PORT ?? 993),
    user: IMAP_USER,
    password: IMAP_PASSWORD,
    mailbox: process.env.IMAP_MAILBOX ?? 'INBOX',
  });
  log(`IMAP poll complete: ${saved} message(s) dropped. Run \`npm run intake\` to process.`);
}
