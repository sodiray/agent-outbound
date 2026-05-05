const normalize = (value: any) => String(value || '').trim().toLowerCase();

const readReplyClassification = (record: any) =>
  normalize(record?.reply_classification_latest || record?.email_reply_classification || '');

const readDisposition = (record: any) =>
  normalize(record?.disposition_latest || record?.call_last_disposition || '');

const readMailState = (record: any) => {
  if (normalize(record?.mail_last_returned_at)) return 'returned';
  if (normalize(record?.mail_last_delivered_at)) return 'delivered';
  if (normalize(record?.mail_last_piece_id)) return 'in_transit';
  return '';
};

const hasReply = (record: any) => Boolean(normalize(record?.email_last_reply_at));

const parseEqTokens = (condition: string) => {
  const matches = [...condition.matchAll(/([a-zA-Z_.]+)\s*(==|=|!=)\s*([a-zA-Z0-9_-]+)/g)];
  return matches.map((match) => ({
    left: normalize(match[1]),
    op: String(match[2] || '=='),
    right: normalize(match[3]),
  }));
};

const evaluateToken = ({ left, op, right }: { left: string; op: string; right: string }, record: any) => {
  const equals = (actual: string) => (op === '!=' ? actual !== right : actual === right);

  if (left === 'reply.classification' || left === 'reply_classification' || left === 'reply_classification_latest' || left === 'email_reply_classification') {
    return equals(readReplyClassification(record));
  }
  if (left === 'visit.disposition' || left === 'disposition' || left === 'disposition_latest') {
    return equals(readDisposition(record));
  }
  if (left === 'mail.state' || left === 'mail_delivery_state') {
    return equals(readMailState(record));
  }
  if (left === 'channel.email.state') {
    const emailState = readReplyClassification(record) === 'bounce' ? 'bounced' : (hasReply(record) ? 'replied' : 'sent');
    return equals(emailState);
  }
  return null;
};

export const evaluateStructuredCondition = ({ conditionText, record }: { conditionText: string; record: any }) => {
  const text = normalize(conditionText);
  if (!text) {
    return { matched: null, reason: '', source: 'none' as const };
  }

  const eqTokens = parseEqTokens(text);
  if (eqTokens.length > 0) {
    let resolved = 0;
    for (const token of eqTokens) {
      const evalResult = evaluateToken(token, record);
      if (evalResult === null) continue;
      resolved += 1;
      if (!evalResult) {
        return {
          matched: false,
          reason: `Structured condition failed: ${token.left} ${token.op} ${token.right}`,
          source: 'structured' as const,
        };
      }
    }
    if (resolved > 0) {
      return {
        matched: true,
        reason: 'Structured condition checks passed.',
        source: 'structured' as const,
      };
    }
  }

  // Common deterministic shorthand patterns.
  if (text.includes('no reply') || text.includes('no replies') || text.includes('still silent')) {
    if (hasReply(record)) {
      return { matched: false, reason: 'Record already has a reply.', source: 'structured' as const };
    }
    return { matched: true, reason: 'No reply detected.', source: 'structured' as const };
  }
  if (text.includes('postcard has been delivered') || text.includes('mail has been delivered')) {
    const state = readMailState(record);
    if (state === 'delivered') return { matched: true, reason: 'Mail delivery confirmed.', source: 'structured' as const };
    if (state === 'in_transit') return { matched: false, reason: 'Mail still in transit.', source: 'structured' as const };
    return { matched: false, reason: 'No delivered mail state found.', source: 'structured' as const };
  }
  if (text.includes('mail returned') || text.includes('returned to sender')) {
    return {
      matched: readMailState(record) === 'returned',
      reason: readMailState(record) === 'returned' ? 'Mail returned state found.' : 'Mail is not returned.',
      source: 'structured' as const,
    };
  }

  return { matched: null, reason: '', source: 'none' as const };
};

