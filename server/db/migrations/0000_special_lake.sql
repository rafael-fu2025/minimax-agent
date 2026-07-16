CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"model" text,
	"system_prompt" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "conversations_id_uuid_check" CHECK ("conversations"."id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"thinking" text,
	"tool_calls" jsonb,
	"tool_call_id" text,
	"tool_name" text,
	"usage" jsonb,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_unique_sequence" UNIQUE("conversation_id","sequence"),
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('system','user','assistant','tool')),
	CONSTRAINT "messages_tool_calls_check" CHECK ("messages"."tool_calls" IS NULL OR jsonb_typeof("messages"."tool_calls") = 'array')
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;