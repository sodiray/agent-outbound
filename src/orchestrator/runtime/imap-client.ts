import { ImapFlow } from 'imapflow';

export type ImapInboxMessage = {
  uid: number;
  source: Buffer;
  internalDate: Date | null;
};

export type ImapConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
};

export const fetchInboxMessages = async (
  config: ImapConnectionConfig,
): Promise<ImapInboxMessage[]> => {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: {
      user: config.user,
      pass: config.password,
    },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const messages: ImapInboxMessage[] = [];
    for await (const message of client.fetch('1:*', {
      uid: true,
      source: true,
      internalDate: true,
    })) {
      if (!message.source || !message.uid) continue;
      messages.push({
        uid: message.uid,
        source: Buffer.from(message.source),
        internalDate: message.internalDate
          ? new Date(message.internalDate)
          : null,
      });
    }
    return messages;
  } finally {
    lock.release();
    await client.logout();
  }
};
