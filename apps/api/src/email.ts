export async function sendProductEmail(to: string, subject: string, text: string) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!key || !from) {
    if (process.env.NODE_ENV !== "production") {
      console.info(
        `\n[Widesip local email preview]\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`,
      );
      return;
    }

    throw new Error("Configure RESEND_API_KEY and RESEND_FROM to send account emails.");
  }

  if (/your[-_ ]verified[-_ ]domain|example\.com/i.test(from)) {
    throw new Error("RESEND_FROM still uses the example sender. Set it to an address on a domain verified in your Resend account.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text }),
  });

  if (!response.ok) {
    let reason = "";
    try {
      const payload = await response.json() as { message?: string; name?: string };
      reason = payload.message ?? payload.name ?? "";
    } catch { /* The provider may return a non-JSON error response. */ }
    throw new Error(`Resend rejected the email (${response.status})${reason ? `: ${reason}` : "."}`);
  }
}
