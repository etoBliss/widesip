export type MessageCategory = "people" | "updates" | "promotions";

function senderAddress(from: string) {
  return from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? from.trim().toLowerCase();
}

function htmlAsText(html: string) {
  return html
    .replace(/<(script|style|head|title|noscript)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

/**
 * Lightweight inbox sorting. It is a best-effort guess based on visible
 * message content; saved sender rules from user corrections take precedence.
 */
export function classifyInboundMessage(input: {
  from: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}): MessageCategory {
  const sender = senderAddress(input.from);
  const subject = input.subject ?? "";
  const body = `${input.text ?? ""} ${input.html ? htmlAsText(input.html) : ""}`;
  const source = `${sender} ${subject} ${body}`.toLowerCase().slice(0, 20_000);

  // Newsletter/list signals are more specific than generic transactional terms.
  if (
    /list-unsubscribe|unsubscribe|email preferences|manage preferences|view this email in your browser|weekly digest|newsletter|marketing|promotion|discount|coupon|limited[- ]time offer|flash sale|new collection|special offer|sale ends/.test(source)
  ) return "promotions";

  if (
    /no[- ]?reply|do not reply|automated message|receipt|invoice|billing|order (?:confirmed|shipped|delivered|update)|shipment|tracking number|verification code|verify your email|security alert|password reset|account statement|service update|maintenance notice|payment (?:received|failed|due)/.test(source)
  ) return "updates";

  return "people";
}

export function normalizeSenderAddress(from: string) {
  return senderAddress(from);
}
