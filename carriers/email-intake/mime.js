// Minimal RFC-822/MIME parser — just enough for carrier reply emails:
// header unfolding, RFC 2047 encoded-words, multipart traversal to the first
// text/plain part, quoted-printable and base64 transfer decoding.

function decodeEncodedWords(value) {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_, charset, enc, data) => {
      try {
        const buf =
          enc.toLowerCase() === 'b'
            ? Buffer.from(data, 'base64')
            : Buffer.from(
                data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) =>
                  String.fromCharCode(parseInt(h, 16))
                ),
                'latin1'
              );
        const cs = charset.toLowerCase();
        return buf.toString(cs.includes('utf') ? 'utf8' : 'latin1');
      } catch {
        return data;
      }
    }
  );
}

export function parseHeaders(headerBlock) {
  const headers = new Map();
  // unfold continuation lines first, then parse line-by-line
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return headers;
}

function bufferCharset(charset) {
  return String(charset ?? 'utf-8').toLowerCase().includes('utf') ? 'utf8' : 'latin1';
}

export function decodeBody(body, transferEncoding, charset = 'utf-8') {
  const enc = String(transferEncoding ?? '').toLowerCase().trim();
  if (enc === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString(bufferCharset(charset));
  }
  if (enc === 'quoted-printable') {
    // Decode to raw bytes first, THEN interpret in the declared charset —
    // multi-byte UTF-8 sequences arrive as several =XX escapes.
    const bytes = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '=') {
        const hex = body.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
        if (body[i + 1] === '\r' && body[i + 2] === '\n') {
          i += 2; // soft line break
          continue;
        }
        if (body[i + 1] === '\n') {
          i += 1;
          continue;
        }
      }
      bytes.push(body.charCodeAt(i) & 0xff);
    }
    return Buffer.from(bytes).toString(bufferCharset(charset));
  }
  return body;
}

function contentTypeOf(headers) {
  const ct = headers.get('content-type') ?? 'text/plain';
  const [type] = ct.split(';');
  const boundaryMatch = ct.match(/boundary="?([^";]+)"?/i);
  const charsetMatch = ct.match(/charset="?([^";]+)"?/i);
  return {
    type: type.trim().toLowerCase(),
    boundary: boundaryMatch?.[1] ?? null,
    charset: charsetMatch?.[1] ?? 'utf-8',
  };
}

/** Depth-first search for the first text/plain body in a MIME tree. */
function extractText(headers, body) {
  const { type, boundary, charset } = contentTypeOf(headers);
  if (type.startsWith('multipart/') && boundary) {
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\r?\n?`));
    for (const part of parts) {
      const trimmed = part.replace(/^\r?\n/, '');
      if (!trimmed.trim()) continue;
      const split = trimmed.split(/\r?\n\r?\n/);
      const partHeaders = parseHeaders(split[0] ?? '');
      const partBody = split.slice(1).join('\n\n');
      const found = extractText(partHeaders, partBody);
      if (found !== null) return found;
    }
    return null;
  }
  if (type === 'text/plain' || !headers.has('content-type')) {
    return decodeBody(body, headers.get('content-transfer-encoding'), charset).trim();
  }
  return null;
}

export function parseAddress(headerValue) {
  if (!headerValue) return { name: null, address: null };
  const decoded = decodeEncodedWords(headerValue);
  const angled = decoded.match(/^(.*?)<([^>]+)>/);
  if (angled) {
    return {
      name: angled[1].trim().replace(/^"|"$/g, '') || null,
      address: angled[2].trim().toLowerCase(),
    };
  }
  const bare = decoded.match(/[^\s@<>,;"]+@[^\s@<>,;"]+/);
  return { name: null, address: bare ? bare[0].toLowerCase() : null };
}

/**
 * Parse one raw RFC-822 message.
 * Returns { headers, from: {name,address}, subject, date, text }.
 */
export function parseMessage(raw) {
  const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const splitAt = str.search(/\r?\n\r?\n/);
  const headerBlock = splitAt === -1 ? str : str.slice(0, splitAt);
  const body = splitAt === -1 ? '' : str.slice(splitAt).replace(/^\r?\n\r?\n/, '');
  const headers = parseHeaders(headerBlock);
  const text = extractText(headers, body) ?? '';
  return {
    headers,
    from: parseAddress(headers.get('from')),
    subject: decodeEncodedWords(headers.get('subject') ?? '(no subject)'),
    date: headers.get('date') ? new Date(headers.get('date')) : null,
    text,
  };
}
