export type MailDnsRecord = {
  type: string;
  name: string;
  value: string;
  ttl?: string | number;
  priority?: number | null;
  status?: string;
};

export type ProviderDomain = {
  id: string;
  name: string;
  status: string;
  records?: MailDnsRecord[];
  capabilities?: { sending?: string; receiving?: string };
};

export type DomainCapabilities = { sending: "enabled" | "disabled"; receiving: "enabled" | "disabled" };

export type SendMessage = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: string; content_type?: string }>;
  scheduledAt?: string;
  tags?: Array<{ name: string; value: string }>;
};

export type ReceivedMessage = {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  created_at?: string;
  message_id?: string | null;
};

/** The application depends on this contract; provider credentials stay server-side. */
export interface MailProvider {
  readonly id: string;
  getDomain(id: string): Promise<ProviderDomain>;
  findDomain(name: string): Promise<ProviderDomain | undefined>;
  createDomain(name: string, receiving?: boolean): Promise<ProviderDomain>;
  updateDomain(id: string, capabilities: DomainCapabilities): Promise<void>;
  verifyDomain(id: string): Promise<void>;
  send(message: SendMessage): Promise<{ id: string }>;
  cancelScheduled(id: string): Promise<void>;
  getReceivedMessage(id: string): Promise<ReceivedMessage>;
}

export function getMailProvider(): MailProvider {
  const provider = process.env.MAIL_TRANSPORT ?? "resend";
  if (provider === "resend") return resendProvider;
  throw new Error(`The configured mail transport "${provider}" is not available.`);
}

async function resendRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("Widesip mail delivery is not configured on the server yet.");
  const response = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as { message?: string; error?: string } & T;
  if (!response.ok) throw new Error(payload.message ?? payload.error ?? `Mail provider returned HTTP ${response.status}.`);
  return payload;
}

const resendProvider: MailProvider = {
  id: "resend",
  getDomain: (id) => resendRequest<ProviderDomain>(`/domains/${encodeURIComponent(id)}`),
  async findDomain(name) {
    const listed = await resendRequest<{ data: ProviderDomain[] }>("/domains?limit=100");
    return listed.data?.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  },
  createDomain: (name, receiving = false) => resendRequest<ProviderDomain>("/domains", {
    method: "POST",
    body: JSON.stringify({ name, region: process.env.RESEND_REGION ?? "us-east-1", custom_return_path: "send", open_tracking: false, click_tracking: false, capabilities: { sending: "enabled", receiving: receiving ? "enabled" : "disabled" } }),
  }),
  async updateDomain(id, capabilities) {
    await resendRequest(`/domains/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ capabilities }) });
  },
  async verifyDomain(id) {
    await resendRequest(`/domains/${encodeURIComponent(id)}/verify`, { method: "POST" });
  },
  send: (message) => {
    const { scheduledAt, ...payload } = message;
    return resendRequest<{ id: string }>("/emails", { method: "POST", body: JSON.stringify({ ...payload, ...(scheduledAt ? { scheduled_at: scheduledAt } : {}) }) });
  },
  async cancelScheduled(id) {
    await resendRequest(`/emails/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  },
  getReceivedMessage: (id) => resendRequest<ReceivedMessage>(`/emails/receiving/${encodeURIComponent(id)}`),
};
