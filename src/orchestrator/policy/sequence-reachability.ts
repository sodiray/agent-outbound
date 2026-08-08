import { isAffirmativeFlag } from './booleanish.js';
import {
  REACHABILITY_CHANNEL_DEFINITIONS,
  type ReachabilityDeliveryCandidates,
} from './timing-reachability.js';

export type SequenceReachability = {
  /** False when a separate standing suppression rule owns the record. */
  applicable: boolean;
  reachable: boolean;
  ready_channels: string[];
  permitted_channels: string[] | null;
};

const normalizeChannel = (value: unknown) => String(value || '').trim().toLowerCase();

const permittedChannelsFromRecord = (
  record: Record<string, unknown>,
): string[] | null => {
  const raw = record.readiness_json;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const permitted = (parsed as Record<string, unknown>).permitted_channels;
    if (!Array.isArray(permitted)) return null;
    return permitted.map(normalizeChannel).filter(Boolean);
  } catch {
    return null;
  }
};

/**
 * Sequence reachability is a current delivery fact, separate from suppression.
 * A current readiness snapshot narrows the engine's channel model. For legacy
 * rows that predate readiness, a non-blocked channel identity is enough to keep
 * the sequence eligible; the named-channel execution gates still fail closed.
 */
export const evaluateSequenceReachability = ({
  record,
  contacts,
}: {
  record: Record<string, unknown>;
  /** When supplied, contacts-table identities are authoritative for reachability. */
  contacts?: Array<Record<string, unknown>>;
}): SequenceReachability => {
  if (isAffirmativeFlag(record.suppressed, { failClosed: true })) {
    return {
      applicable: false,
      reachable: false,
      ready_channels: [],
      permitted_channels: permittedChannelsFromRecord(record),
    };
  }

  const directIdentityPresent = Boolean(
    String(record.contact_email || '').trim()
    || String(record.contact_name || record.contact_name_primary || '').trim(),
  );
  const contactCandidates = contacts === undefined || contacts.length === 0
    ? (directIdentityPresent ? [record] : [])
    : contacts.map((contact) => ({
      ...record,
      contact_email: String(contact.email || '').trim(),
      email_primary: '',
      phone: String(contact.phone || '').trim(),
      contact_phone: String(contact.phone || '').trim(),
      linkedin_url: String(contact.linkedin_url || '').trim(),
      contact_linkedin_url: String(contact.linkedin_url || '').trim(),
      dne_email: contact.dne_email,
      dnc_phone: contact.dnc_phone,
      dne_phone: contact.dne_phone,
      linkedin_suppressed: contact.linkedin_suppressed,
      suppression_state: contact.suppression_state,
    }));
  const deliveryCandidates: ReachabilityDeliveryCandidates = {
    account: record,
    contacts: contactCandidates,
  };
  const ready_channels = Array.from(new Set(
    REACHABILITY_CHANNEL_DEFINITIONS.flatMap(({ channel, deliveryCandidates: candidatesForChannel, evaluate }) => (
      candidatesForChannel(deliveryCandidates)
        .map((candidate) => evaluate(candidate))
        .filter((state) => (
          state.ready
          || (
            state.state === 'unvalidated'
            && state.reason !== 'invalid_verification'
          )
        ))
        .map(() => channel)
    )),
  ));
  const permitted_channels = permittedChannelsFromRecord(record);
  const reachable_channels = permitted_channels === null
    ? ready_channels
    : ready_channels.filter((channel) => permitted_channels.includes(channel));

  return {
    applicable: true,
    reachable: reachable_channels.length > 0,
    ready_channels: reachable_channels,
    permitted_channels,
  };
};

export const unreachableSequencePatch = () => ({
  sequence_status: 'unreachable',
  account_sequence_state: 'unreachable',
  next_action_date: '',
  last_error: 'No reachable contact on a permitted channel.',
});

export const reenteredSequencePatch = () => ({
  sequence_status: 'active',
  account_sequence_state: 'active',
  last_error: '',
});
