import type { IConnectionManager } from '../connections/types.js';
import ImapService from './imap.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockImapClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn().mockReturnValue((async function* fetchMock() {})()),
    fetchOne: vi.fn().mockResolvedValue(false),
    download: vi.fn().mockResolvedValue({ content: null }),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    _releaseFn: releaseFn,
  };
}

/** Join lines with CRLF, as a real RFC822 message uses. */
function mime(...lines: (string | Buffer)[]): Buffer {
  return Buffer.concat(
    lines.flatMap((l) => [Buffer.isBuffer(l) ? l : Buffer.from(l, 'binary'), Buffer.from('\r\n')]),
  );
}

/** A fetchOne/fetch result carrying `source`, the shape imapflow returns. */
function message(uid: number, source: Buffer) {
  return {
    uid,
    seq: uid,
    flags: new Set(['\\Seen']),
    envelope: { subject: 'Subject', from: [{ name: 'A', address: 'a@example.test' }] },
    bodyStructure: {},
    source,
  };
}

/** The async iterator shape client.fetch() returns. */
async function* iterate(...msgs: ReturnType<typeof message>[]) {
  for (const msg of msgs) yield msg;
}

function createMockConnectionManager(mockClient: ReturnType<typeof createMockImapClient>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn().mockResolvedValue(mockClient),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  // -----------------------------------------------------------------------
  // listMailboxes
  // -----------------------------------------------------------------------

  describe('listMailboxes', () => {
    it('returns mailbox list with message counts', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent' },
      ]);
      client.status.mockResolvedValue({ messages: 10, unseen: 3 });

      const result = await service.listMailboxes('test');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'INBOX',
        path: 'INBOX',
        specialUse: '\\Inbox',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(result[1]).toEqual({
        name: 'Sent',
        path: 'Sent',
        specialUse: '\\Sent',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(client.status).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // moveEmail
  // -----------------------------------------------------------------------

  describe('moveEmail', () => {
    it('moves email between mailboxes', async () => {
      // assertRealMailbox calls client.list() internally
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);

      await service.moveEmail('test', '42', 'INBOX', 'Archive');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
      expect(client.messageMove).toHaveBeenCalledWith('42', 'Archive', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('calls sanitizeMailboxName on inputs', async () => {
      client.list.mockResolvedValue([]);

      // Passing valid names — sanitize should pass them through without error
      await service.moveEmail('test', '1', 'INBOX', 'Sent');

      expect(client.messageMove).toHaveBeenCalledWith('1', 'Sent', { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // deleteEmail
  // -----------------------------------------------------------------------

  describe('deleteEmail', () => {
    it('permanently deletes when permanent=true', async () => {
      await service.deleteEmail('test', '99', 'INBOX', true);

      expect(client.messageDelete).toHaveBeenCalledWith('99', { uid: true });
      expect(client.messageMove).not.toHaveBeenCalled();
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('moves to trash when permanent=false', async () => {
      // assertRealMailbox + trash detection both call client.list()
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Trash', path: 'Trash', specialUse: '\\Trash' },
      ]);

      await service.deleteEmail('test', '99', 'INBOX', false);

      expect(client.messageDelete).not.toHaveBeenCalled();
      expect(client.messageMove).toHaveBeenCalledWith('99', 'Trash', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // setFlags
  // -----------------------------------------------------------------------

  describe('setFlags', () => {
    it('adds Seen flag for read action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'read');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    });

    it('removes Seen flag for unread action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'unread');

      expect(client.messageFlagsRemove).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('adds Flagged flag for flag action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'flag');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Flagged'], { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // Mailbox-scoped IDs
  //
  // IMAP UIDs are unique only within a mailbox, so an ID must select the
  // mailbox it came from. Resolving one against the wrong mailbox returns a
  // different, real message instead of an error — these tests pin the mailbox
  // each operation actually locks.
  // -----------------------------------------------------------------------

  describe('mailbox-scoped IDs', () => {
    const SCOPED = '[Gmail]/All Mail:212711';

    it('moveEmail locks the mailbox named in the ID, not the argument', async () => {
      // A real (non-virtual) folder: moveEmail refuses to move out of Gmail's
      // virtual All Mail regardless of how the mailbox was resolved.
      client.list.mockResolvedValue([{ name: 'Receipts', path: 'Receipts' }]);

      await service.moveEmail('test', 'Receipts:8817', 'INBOX', 'Archive');

      expect(client.getMailboxLock).toHaveBeenCalledWith('Receipts');
      expect(client.messageMove).toHaveBeenCalledWith('8817', 'Archive', { uid: true });
    });

    it('setFlags locks the mailbox named in the ID', async () => {
      await service.setFlags('test', SCOPED, 'INBOX', 'read');

      expect(client.getMailboxLock).toHaveBeenCalledWith('[Gmail]/All Mail');
      expect(client.messageFlagsAdd).toHaveBeenCalledWith('212711', ['\\Seen'], { uid: true });
    });

    it('deleteEmail locks the mailbox named in the ID', async () => {
      await service.deleteEmail('test', SCOPED, 'INBOX', true);

      expect(client.getMailboxLock).toHaveBeenCalledWith('[Gmail]/All Mail');
      expect(client.messageDelete).toHaveBeenCalledWith('212711', { uid: true });
    });

    it('still resolves bare legacy UIDs against the mailbox argument', async () => {
      await service.setFlags('test', '10', '[Gmail]/Sent Mail', 'read');

      expect(client.getMailboxLock).toHaveBeenCalledWith('[Gmail]/Sent Mail');
      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
    });

    it('bulkDelete refuses IDs spanning mailboxes instead of guessing', async () => {
      await expect(
        service.bulkDelete('test', ['INBOX:1', '[Gmail]/All Mail:2'], 'INBOX', true),
      ).rejects.toThrow(/single mailbox/);

      expect(client.messageDelete).not.toHaveBeenCalled();
    });

    it('bulkSetFlags applies UIDs to the mailbox the IDs name', async () => {
      await service.bulkSetFlags(
        'test',
        ['[Gmail]/All Mail:1', '[Gmail]/All Mail:2'],
        'INBOX',
        'mark_read',
      );

      expect(client.getMailboxLock).toHaveBeenCalledWith('[Gmail]/All Mail');
      expect(client.messageFlagsAdd).toHaveBeenCalledWith('1,2', ['\\Seen'], { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // Body parsing
  //
  // Bodies come out of the `source` already fetched alongside the envelope.
  // The service must never go back to the server for an individual part:
  // imapflow's download() rewrites its own fetch range from the first untagged
  // FETCH it observes, so a stray FLAGS notification for a neighbouring UID
  // made it stream a different message's body under the right headers.
  // -----------------------------------------------------------------------

  describe('body parsing', () => {
    const ALTERNATIVE = mime(
      'From: a@example.test',
      'Subject: Hello',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'plain body',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>html body</p>',
      '--b1--',
    );

    it('never downloads individual parts', async () => {
      client.fetchOne.mockResolvedValue(message(42, ALTERNATIVE));

      await service.getEmail('test', 'INBOX:42');

      expect(client.download).not.toHaveBeenCalled();
    });

    it('rejects a fetch answered with a different message', async () => {
      client.fetchOne.mockResolvedValue(message(43, ALTERNATIVE));

      await expect(service.getEmail('test', 'INBOX:42')).rejects.toThrow(/stray untagged FETCH/);
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('picks both parts out of multipart/alternative', async () => {
      client.fetchOne.mockResolvedValue(message(42, ALTERNATIVE));

      const email = await service.getEmail('test', 'INBOX:42');

      expect(email.bodyText?.trim()).toBe('plain body');
      expect(email.bodyHtml?.trim()).toBe('<p>html body</p>');
    });

    it('descends into multipart/mixed instead of returning the container', async () => {
      // The old code hardcoded part '1', which on this shape is the
      // multipart/alternative container: boundaries and undecoded base64.
      client.fetchOne.mockResolvedValue(
        message(
          42,
          mime(
            'Content-Type: multipart/mixed; boundary="outer"',
            '',
            '--outer',
            'Content-Type: multipart/alternative; boundary="inner"',
            '',
            '--inner',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'the real text',
            '--inner--',
            '--outer',
            'Content-Type: application/pdf; name="r.pdf"',
            'Content-Disposition: attachment; filename="r.pdf"',
            'Content-Transfer-Encoding: base64',
            '',
            'JVBERi0xLjQK',
            '--outer--',
          ),
        ),
      );

      const email = await service.getEmail('test', 'INBOX:42');

      expect(email.bodyText?.trim()).toBe('the real text');
      expect(email.bodyText).not.toContain('--inner');
      expect(email.bodyText).not.toContain('JVBERi0');
    });

    it('skips attachment parts when choosing the body', async () => {
      client.fetchOne.mockResolvedValue(
        message(
          42,
          mime(
            'Content-Type: multipart/mixed; boundary="m"',
            '',
            '--m',
            'Content-Type: text/plain; charset=utf-8',
            'Content-Disposition: attachment; filename="notes.txt"',
            '',
            'attached notes',
            '--m',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'the message itself',
            '--m--',
          ),
        ),
      );

      const email = await service.getEmail('test', 'INBOX:42');

      expect(email.bodyText?.trim()).toBe('the message itself');
    });

    it('decodes base64 transfer encoding', async () => {
      client.fetchOne.mockResolvedValue(
        message(
          42,
          mime(
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from('decoded from base64').toString('base64'),
          ),
        ),
      );

      const email = await service.getEmail('test', 'INBOX:42');

      expect(email.bodyText).toBe('decoded from base64');
    });

    it('decodes quoted-printable, including soft line breaks', async () => {
      client.fetchOne.mockResolvedValue(
        message(
          42,
          mime(
            'Content-Type: text/plain; charset=utf-8',
            'Content-Transfer-Encoding: quoted-printable',
            '',
            'soft=',
            'wrapped =3D sign',
          ),
        ),
      );

      const email = await service.getEmail('test', 'INBOX:42');

      expect(email.bodyText?.trim()).toBe('softwrapped = sign');
    });

    it('decodes ISO-2022-JP bodies', async () => {
      // ESC $ B ... ESC ( B — the escape-sequence charset most Japanese mail
      // still arrives in, which a plain utf-8 read turns into mojibake.
      const jis = Buffer.from([
        0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42,
      ]);
      client.fetchOne.mockResolvedValue(
        message(42, mime('Content-Type: text/plain; charset=ISO-2022-JP', '', jis)),
      );

      const email = await service.getEmail('test', 'INBOX:42');

      expect(email.bodyText?.trim()).toBe('日本語');
    });

    it('unfolds continuation headers', async () => {
      client.fetchOne.mockResolvedValue(
        message(
          42,
          mime(
            'Content-Type: text/plain; charset=utf-8',
            'References: <one@example.test>',
            '\t<two@example.test>',
            '',
            'body',
          ),
        ),
      );

      const email = await service.getEmail('test', 'INBOX:42');

      expect(email.headers.references).toBe('<one@example.test> <two@example.test>');
      expect(email.references).toEqual(['<one@example.test>', '<two@example.test>']);
    });

    it('previews list entries with the same MIME walk', async () => {
      client.search.mockResolvedValue([42]);
      client.fetch.mockReturnValue(iterate(message(42, ALTERNATIVE)));

      const { items } = await service.listEmails('test', { mailbox: 'INBOX' });

      expect(items[0]?.preview).toBe('plain body');
    });
  });
});
