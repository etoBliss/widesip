CREATE OR REPLACE FUNCTION public.widesip_notify_message_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify('widesip_updates', json_build_object('workspaceId', NEW.workspace_id, 'mailboxId', NEW.mailbox_id)::text);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "messages_notify_widesip_updates"
AFTER INSERT OR UPDATE ON "messages"
FOR EACH ROW EXECUTE FUNCTION public.widesip_notify_message_change();
