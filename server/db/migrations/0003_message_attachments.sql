-- Add `attachments` jsonb column to `messages` for multimodal content parts
-- (text + image_url + video_url). `content` keeps the joined plain-text view
-- so existing consumers (auto-title, memory indexing, search) keep working.
ALTER TABLE "messages" ADD COLUMN "attachments" jsonb;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachments_check" CHECK (
  "messages"."attachments" IS NULL OR jsonb_typeof("messages"."attachments") = 'array'
);
