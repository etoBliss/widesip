import { CompanyPage } from "@/components/company-page";

export default function SecurityPage(){
  return <CompanyPage title="Security should be clear, not mysterious." intro="Widesip is adding practical account and session safeguards while the product is developed. These controls describe the current application; they are not a certification or a promise that every deployment risk has been eliminated." sections={[
    {title:"Account protection",body:<p>Password sign-in requires at least 12 characters. Authentication requests are rate-limited. Repeated incorrect password attempts trigger timed account lockouts that grow from 30 seconds up to one hour, and successful sign-in clears the failed-attempt counter. Production authentication requires Cloudflare Turnstile bot verification.</p>},
    {title:"Session controls",body:<p>Sessions are stored server-side and expire after 12 hours without activity. Signed-in users can review active devices and IP addresses in Settings, revoke individual sessions, or sign out other devices. Password changes revoke other sessions. Production cookies are configured for HTTPS.</p>},
    {title:"Mail and data handling",body:<p>Widesip's inbox features store message content in the application database and process it through the API and configured mail provider. Production must use HTTPS to protect connections in transit. Messages are not end-to-end encrypted by Widesip today. Do not use this development service for sensitive production mail.</p>},
    {title:"Development and verification",body:<p>Widesip is still in development. Before public production use, the complete deployed service, infrastructure, operational procedures and data flows need a security review against a defined standard such as OWASP ASVS. This page does not claim formal compliance or independent certification.</p>},
    {title:"Report a concern",body:<p>If you notice a security issue, contact the Widesip team with a clear description and steps to reproduce it. Please avoid sharing other people's personal information in a report.</p>},
  ]} />;
}
