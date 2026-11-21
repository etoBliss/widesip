import { redirect } from "next/navigation";

export default function LegacyInvitationsRedirect() {
  redirect("/app/team/invitations");
}
