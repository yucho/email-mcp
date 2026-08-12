import { formatEmailId, parseEmailId, parseEmailIds } from './email-id.js';

describe('formatEmailId', () => {
  it('scopes a UID to its mailbox', () => {
    expect(formatEmailId('INBOX', 155747)).toBe('INBOX:155747');
    expect(formatEmailId('[Gmail]/All Mail', 212711)).toBe('[Gmail]/All Mail:212711');
  });
});

describe('parseEmailId', () => {
  it('round-trips a scoped ID', () => {
    const id = formatEmailId('[Gmail]/Sent Mail', 3591);
    expect(parseEmailId(id, 'INBOX')).toEqual({ uid: 3591, mailbox: '[Gmail]/Sent Mail' });
  });

  it('prefers the mailbox in the ID over the fallback', () => {
    // The regression this module exists for: the fallback would have silently
    // resolved UID 212711 against INBOX and returned a different real message.
    expect(parseEmailId('[Gmail]/All Mail:212711', 'INBOX')).toEqual({
      uid: 212711,
      mailbox: '[Gmail]/All Mail',
    });
  });

  it('treats a bare UID as legacy and uses the fallback mailbox', () => {
    expect(parseEmailId('155747', 'INBOX')).toEqual({ uid: 155747, mailbox: 'INBOX' });
  });

  it('splits on the last separator so mailbox names may contain colons', () => {
    expect(parseEmailId('Archive:2024:42', 'INBOX')).toEqual({
      uid: 42,
      mailbox: 'Archive:2024',
    });
  });

  it('treats a non-numeric tail as not-a-scoped-ID', () => {
    expect(() => parseEmailId('INBOX:abc', 'INBOX')).toThrow(/Invalid email ID/);
  });

  it('does not read a leading separator as an empty mailbox', () => {
    expect(() => parseEmailId(':123', 'INBOX')).toThrow(/Invalid email ID/);
  });

  it('rejects junk', () => {
    expect(() => parseEmailId('', 'INBOX')).toThrow(/Invalid email ID/);
    expect(() => parseEmailId('0', 'INBOX')).toThrow(/Invalid email ID/);
    expect(() => parseEmailId('-5', 'INBOX')).toThrow(/Invalid email ID/);
  });
});

describe('parseEmailIds', () => {
  it('collects UIDs sharing one mailbox', () => {
    expect(parseEmailIds(['INBOX:1', 'INBOX:2', 'INBOX:3'], '[Gmail]/All Mail')).toEqual({
      uids: [1, 2, 3],
      mailbox: 'INBOX',
    });
  });

  it('accepts legacy numeric IDs', () => {
    expect(parseEmailIds([1, 2], 'INBOX')).toEqual({ uids: [1, 2], mailbox: 'INBOX' });
  });

  it('rejects IDs spanning multiple mailboxes rather than guessing', () => {
    expect(() => parseEmailIds(['INBOX:1', '[Gmail]/All Mail:2'], 'INBOX')).toThrow(
      /single mailbox/,
    );
  });

  it('handles an empty batch', () => {
    expect(parseEmailIds([], 'INBOX')).toEqual({ uids: [], mailbox: 'INBOX' });
  });
});
