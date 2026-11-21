import { MailMessagePage } from "@/components/mail-message-page";

export default async function MessagePage({ params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  return <MailMessagePage messageId={messageId}/>;
}
