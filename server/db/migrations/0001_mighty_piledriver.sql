CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "memories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" bigserial NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_role_check" CHECK ("memories"."role" IN ('user','assistant'))
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_conversation_idx" ON "memories" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "memories_message_idx" ON "memories" USING btree ("message_id");