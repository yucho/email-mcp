/**
 * Mailbox-scoped email identifiers.
 *
 * IMAP UIDs are unique only *within* a mailbox (RFC 3501 §2.3.1.1), so a bare
 * UID is not a usable identifier once more than one mailbox is in play. The
 * same physical message carries a different UID in `INBOX` than in
 * `[Gmail]/All Mail`, and each of those UIDs also refers to some *other*
 * message in the opposite mailbox. Fetching a UID against the wrong mailbox
 * therefore returns a different, real, plausible-looking email rather than an
 * error — silent data corruption from the caller's point of view.
 *
 * These helpers make the mailbox part of the identifier itself, so an ID
 * handed back by `list_emails` cannot be mis-resolved by a later `get_email`.
 *
 * Format: `<mailbox>:<uid>` — e.g. `[Gmail]/All Mail:212711`.
 *
 * Bare numeric IDs are still accepted, resolving against the caller-supplied
 * mailbox exactly as before, so existing callers and stored IDs keep working.
 */

const SEPARATOR = ':';

export interface ParsedEmailId {
  uid: number;
  mailbox: string;
}

/** Build a mailbox-scoped ID. */
export function formatEmailId(mailbox: string, uid: number | string): string {
  return `${mailbox}${SEPARATOR}${uid}`;
}

/**
 * Resolve an email ID to its UID and owning mailbox.
 *
 * Scoped IDs carry their own mailbox and ignore `fallbackMailbox`; bare UIDs
 * fall back to it. Mailbox names may themselves contain `:`, so the split is
 * on the *last* separator and only when the tail is numeric.
 */
export function parseEmailId(emailId: string, fallbackMailbox: string): ParsedEmailId {
  const separatorIdx = emailId.lastIndexOf(SEPARATOR);

  if (separatorIdx > 0) {
    const uidPart = emailId.slice(separatorIdx + 1);
    if (/^\d+$/.test(uidPart)) {
      return { uid: Number.parseInt(uidPart, 10), mailbox: emailId.slice(0, separatorIdx) };
    }
  }

  const uid = Number.parseInt(emailId, 10);
  if (!Number.isInteger(uid) || uid <= 0) {
    throw new Error(
      `Invalid email ID "${emailId}". Expected a UID or a mailbox-scoped ID such as "INBOX:123".`,
    );
  }
  return { uid, mailbox: fallbackMailbox };
}

/**
 * Resolve a batch of IDs that must share one mailbox, since IMAP batch
 * operations act on a single selected mailbox.
 *
 * Mixed mailboxes are rejected loudly: applying one mailbox's UIDs to another
 * is precisely the silent-corruption case this module exists to prevent, and
 * for a bulk delete or move the damage would be irreversible.
 */
export function parseEmailIds(
  emailIds: (string | number)[],
  fallbackMailbox: string,
): { uids: number[]; mailbox: string } {
  if (emailIds.length === 0) {
    return { uids: [], mailbox: fallbackMailbox };
  }

  const parsed = emailIds.map((id) => parseEmailId(String(id), fallbackMailbox));
  const mailboxes = new Set(parsed.map((p) => p.mailbox));

  if (mailboxes.size > 1) {
    throw new Error(
      `Bulk operations require a single mailbox, but the supplied IDs span ${mailboxes.size}: ` +
        `${[...mailboxes].map((m) => `"${m}"`).join(', ')}. Split the call per mailbox.`,
    );
  }

  return { uids: parsed.map((p) => p.uid), mailbox: parsed[0].mailbox };
}
