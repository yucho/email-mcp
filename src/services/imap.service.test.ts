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
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    _releaseFn: releaseFn,
  };
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
});
