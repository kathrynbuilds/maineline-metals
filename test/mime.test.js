import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMessage, decodeBody, parseAddress } from '../carriers/email-intake/mime.js';

const REPLIES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replies');
const fixture = (name) => readFileSync(join(REPLIES, name));

test('multipart + quoted-printable: extracts the text/plain part only', () => {
  const msg = parseMessage(fixture('reply-enthusiastic-yes.eml'));
  assert.equal(msg.from.address, 'dispatch@ozarksteel.example');
  assert.equal(msg.from.name, 'Randy Whitfield');
  assert.match(msg.subject, /Blytheville ↔ Atlanta/, 'RFC 2047 encoded word decoded');
  assert.match(msg.text, /Yes ma’am, that lane is right in our wheelhouse/);
  assert.match(msg.text, /\$2\.50-2\.90\/mi/);
  assert.ok(!msg.text.includes('<html>'), 'HTML part not leaked');
  assert.ok(!msg.text.includes('=E2'), 'quoted-printable fully decoded');
});

test('base64 body decodes', () => {
  const msg = parseMessage(fixture('reply-out-of-office.eml'));
  assert.match(msg.text, /out of the office until Monday July 13th/);
});

test('plain 7bit body passes through; headers are case-insensitive', () => {
  const msg = parseMessage(fixture('reply-terse-yes-rate.eml'));
  assert.match(msg.text, /2\.60 a mile/);
  assert.equal(msg.headers.get('subject'), 'Re: carrier setup');
});

test('decodeBody handles soft line breaks and hex escapes', () => {
  assert.equal(decodeBody('foo=\r\nbar', 'quoted-printable'), 'foobar');
  assert.equal(decodeBody('a=3Db', 'quoted-printable'), 'a=b');
  assert.equal(decodeBody(Buffer.from('hi there').toString('base64'), 'base64'), 'hi there');
  assert.equal(decodeBody('unchanged', '7bit'), 'unchanged');
});

test('parseAddress handles angle brackets, quotes, and bare addresses', () => {
  assert.deepEqual(parseAddress('"Gulf Coast Metals LLC" <GCM@GulfCoast.example>'), {
    name: 'Gulf Coast Metals LLC',
    address: 'gcm@gulfcoast.example',
  });
  assert.equal(parseAddress('psfdispatch@psf.example').address, 'psfdispatch@psf.example');
  assert.equal(parseAddress(undefined).address, null);
});
