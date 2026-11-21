CREATE OR REPLACE FUNCTION public.widesip_notify_campaign_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify('widesip_updates', json_build_object(
		'type', 'campaign',
		'workspaceId', NEW.workspace_id,
		'mailboxId', NEW.mailbox_id
	)::text);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "campaigns_notify_widesip_updates"
AFTER INSERT OR UPDATE OF status ON "campaigns"
FOR EACH ROW EXECUTE FUNCTION public.widesip_notify_campaign_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.widesip_notify_campaign_recipient_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	workspace_id uuid;
	mailbox_id uuid;
BEGIN
	SELECT c.workspace_id, c.mailbox_id INTO workspace_id, mailbox_id
	FROM campaigns c
	WHERE c.id = NEW.campaign_id;
	IF workspace_id IS NOT NULL AND mailbox_id IS NOT NULL THEN
		PERFORM pg_notify('widesip_updates', json_build_object(
			'type', 'campaign',
			'workspaceId', workspace_id,
			'mailboxId', mailbox_id
		)::text);
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "campaign_recipients_notify_widesip_updates"
AFTER UPDATE OF status, provider_message_id ON "campaign_recipients"
FOR EACH ROW EXECUTE FUNCTION public.widesip_notify_campaign_recipient_change();
