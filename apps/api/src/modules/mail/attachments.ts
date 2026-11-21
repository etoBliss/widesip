export type EmailAttachment = { filename: string; contentType: string; content: string };

const MAX_TOTAL_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const blockedExtensions = /\.(?:ade|adp|apk|app|bat|cab|cmd|com|cpl|dll|dmg|exe|hta|jar|js|jse|lnk|msi|msp|mst|php|ps1|reg|scr|sh|vb|vbe|vbs|wsf|wsh)$/i;

export function validateEmailAttachments(value: EmailAttachment[]) {
  if (value.length > 8) throw new Error("Attach up to eight files per email.");
  let totalBytes = 0;
  const safe = value.map(file => {
    const filename = file.filename.replace(/[\\/]/g, "_").replace(/[\r\n\0]/g, "").trim().slice(0, 180);
    if (!filename || blockedExtensions.test(filename)) throw new Error("One attachment has an unsafe filename or file type.");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) throw new Error(`The attachment “${filename}” is not valid base64 data.`);
    const size = Buffer.byteLength(file.content, "base64");
    if (!size) throw new Error(`The attachment “${filename}” is empty.`);
    totalBytes += size;
    return { filename, contentType: file.contentType.slice(0, 120), content: file.content };
  });
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments must total 6 MB or less.");
  return safe;
}

export function personalizeCampaignText(value: string, recipient: { email: string; name: string }) {
  const fullName = recipient.name.trim();
  const [firstPart, ...lastParts] = fullName ? fullName.split(/\s+/) : [];
  const firstName = firstPart || "there";
  const lastName = lastParts.join(" ");
  const replacements: Record<string, string> = {
    firstname: firstName,
    first_name: firstName,
    lastname: lastName,
    last_name: lastName,
    name: fullName || firstName,
    email: recipient.email,
  };
  return value.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => replacements[key.toLowerCase()] ?? match);
}
