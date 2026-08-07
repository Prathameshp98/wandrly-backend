CREATE TYPE "public"."block_type" AS ENUM('ACTIVITY', 'ACCOMMODATION', 'TRANSPORT', 'RESTAURANT', 'TICKET', 'PHOTO', 'VIDEO', 'LINK', 'MAP_PIN', 'NOTE', 'BUDGET');--> statement-breakpoint
CREATE TYPE "public"."email_state" AS ENUM('NOT_REQUIRED', 'PENDING', 'BATCHED', 'SENT', 'SUPPRESSED');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('TRANSPORT', 'ACCOMMODATION', 'FOOD', 'ACTIVITY', 'SHOPPING', 'FEES', 'GROCERIES', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."invite_status" AS ENUM('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."media_source" AS ENUM('UPLOAD', 'UNSPLASH', 'URL');--> statement-breakpoint
CREATE TYPE "public"."media_state" AS ENUM('PENDING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('OWNER', 'EDITOR', 'CONTRIBUTOR', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('COMMENT', 'BLOCK', 'INVITE', 'EDIT', 'MENTION', 'EXPENSE', 'SETTLEMENT', 'SETTLEMENT_CONFIRMED', 'SETTLEMENT_NUDGE');--> statement-breakpoint
CREATE TYPE "public"."settlement_method" AS ENUM('UPI', 'BANK', 'CASH', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."split_method" AS ENUM('EQUAL', 'EXACT', 'PERCENT', 'SHARES', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."trip_mode" AS ENUM('FULL', 'EXPENSES_ONLY');--> statement-breakpoint
CREATE TYPE "public"."trip_status" AS ENUM('DRAFT', 'PLANNING', 'CONFIRMED', 'COMPLETED');--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"base_currency" char(3) NOT NULL,
	"quote_currency" char(3) NOT NULL,
	"rate" text NOT NULL,
	"as_of" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"route" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
	"storage_key" text,
	"external_ref" text,
	"source" "media_source" NOT NULL,
	"mime_type" text,
	"byte_size" integer,
	"width" integer,
	"height" integer,
	"blurhash" text,
	"alt_text" text,
	"attribution" text,
	"state" "media_state" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'dark' NOT NULL,
	"accent" text DEFAULT '#F0A05A' NOT NULL,
	"treatment" text DEFAULT 'clean' NOT NULL,
	"type_emphasis" text DEFAULT 'utility' NOT NULL,
	"block_layout" text DEFAULT 'rows' NOT NULL,
	"density" text DEFAULT 'standard' NOT NULL,
	"show_compass" boolean DEFAULT false NOT NULL,
	"show_quote" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"avatar_tone" text DEFAULT 'gold' NOT NULL,
	"home_city" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"default_currency" char(3) DEFAULT 'INR' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"email_notifications_enabled" boolean DEFAULT true NOT NULL,
	"weekly_digest_enabled" boolean DEFAULT false NOT NULL,
	"pending_deletion_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"emoji" text NOT NULL,
	"tone" text NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_name_len" CHECK (char_length("folders"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "trip_members" (
	"trip_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"invited_by" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone,
	CONSTRAINT "trip_members_trip_id_user_id_pk" PRIMARY KEY("trip_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "trip_user_state" (
	"trip_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "trip_user_state_trip_id_user_id_pk" PRIMARY KEY("trip_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"folder_id" uuid,
	"title" text NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"destination" text DEFAULT '' NOT NULL,
	"place_id" text,
	"start_date" date,
	"end_date" date,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"status" "trip_status" DEFAULT 'DRAFT' NOT NULL,
	"trip_mode" "trip_mode" DEFAULT 'FULL' NOT NULL,
	"base_currency" char(3) DEFAULT 'INR' NOT NULL,
	"simplify_debts" boolean DEFAULT true NOT NULL,
	"cover_asset_id" uuid,
	"cover_hue" smallint DEFAULT 200 NOT NULL,
	"cover_hue2" smallint DEFAULT 240 NOT NULL,
	"main_variant_id" uuid,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trips_title_len" CHECK (char_length("trips"."title") between 1 and 80),
	CONSTRAINT "trips_date_order" CHECK ("trips"."end_date" is null or "trips"."start_date" is null or "trips"."end_date" >= "trips"."start_date")
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"day_id" uuid NOT NULL,
	"type" "block_type" NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"time_label" text DEFAULT '' NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"meta" text DEFAULT '' NOT NULL,
	"notes" text,
	"is_confirmed" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "days" (
	"id" uuid PRIMARY KEY NOT NULL,
	"variant_id" uuid NOT NULL,
	"day_number" integer NOT NULL,
	"date" date,
	"title" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" "trip_status" DEFAULT 'PLANNING' NOT NULL,
	"weather_cache" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "days_number_positive" CHECK ("days"."day_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "packing_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"category" text NOT NULL,
	"label" text NOT NULL,
	"is_checked" boolean DEFAULT false NOT NULL,
	"checked_by" uuid,
	"checked_at" timestamp with time zone,
	"is_template" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packing_label_len" CHECK (char_length("packing_items"."label") between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "trip_notes" (
	"trip_id" uuid PRIMARY KEY NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"forked_from_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_name_len" CHECK (char_length("variants"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "expense_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expense_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"amount_base_minor" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_shares" (
	"expense_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"share_amount_minor" bigint NOT NULL,
	"share_amount_base_minor" bigint NOT NULL,
	"share_input" numeric(18, 6),
	CONSTRAINT "expense_shares_expense_id_participant_id_pk" PRIMARY KEY("expense_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"description" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"fx_rate_to_base" numeric(18, 8) NOT NULL,
	"fx_rate_source" text DEFAULT 'AUTO' NOT NULL,
	"amount_base_minor" bigint NOT NULL,
	"spent_at" timestamp with time zone NOT NULL,
	"category" "expense_category" DEFAULT 'OTHER' NOT NULL,
	"split_method" "split_method" DEFAULT 'EQUAL' NOT NULL,
	"block_id" uuid,
	"day_id" uuid,
	"receipt_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_nonzero" CHECK ("expenses"."amount_minor" <> 0),
	CONSTRAINT "expenses_desc_len" CHECK (char_length("expenses"."description") between 1 and 120),
	CONSTRAINT "expenses_fx_positive" CHECK ("expenses"."fx_rate_to_base" > 0),
	CONSTRAINT "expenses_fx_source" CHECK ("expenses"."fx_rate_source" in ('AUTO','MANUAL'))
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"from_participant_id" uuid NOT NULL,
	"to_participant_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"method" "settlement_method" DEFAULT 'OTHER' NOT NULL,
	"note" text,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid NOT NULL,
	"confirmed_by_payee" boolean DEFAULT false NOT NULL,
	"confirmed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlements_positive" CHECK ("settlements"."amount_minor" > 0),
	CONSTRAINT "settlements_distinct" CHECK ("settlements"."from_participant_id" <> "settlements"."to_participant_id")
);
--> statement-breakpoint
CREATE TABLE "trip_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"avatar_tone" text DEFAULT 'gold' NOT NULL,
	"claim_invite_email" "citext",
	"claimed_at" timestamp with time zone,
	"payout_upi_id" text,
	"payout_bank_ref" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_name_len" CHECK (char_length("trip_participants"."display_name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"block_id" uuid,
	"parent_comment_id" uuid,
	"author_id" uuid,
	"guest_name" text,
	"guest_token_hash" text,
	"body" text NOT NULL,
	"mentioned_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_body_len" CHECK (char_length("comments"."body") between 1 and 2000),
	CONSTRAINT "comments_author" CHECK ("comments"."author_id" is not null or "comments"."guest_name" is not null)
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"role" "member_role" NOT NULL,
	"personal_note" text,
	"token_hash" text NOT NULL,
	"status" "invite_status" DEFAULT 'PENDING' NOT NULL,
	"claims_participant_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"sent_by" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"trip_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"actor_id" uuid,
	"entity_type" text,
	"entity_id" uuid,
	"body" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"email_state" "email_state" DEFAULT 'NOT_REQUIRED' NOT NULL,
	"email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"variant_id" uuid,
	"slug" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"allow_comments" boolean DEFAULT false NOT NULL,
	"allow_suggestions" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trip_id" uuid NOT NULL,
	"day_id" uuid,
	"proposed_block" jsonb NOT NULL,
	"rationale" text,
	"proposed_by" uuid,
	"guest_name" text,
	"status" "suggestion_status" DEFAULT 'PENDING' NOT NULL,
	"reviewed_by" uuid,
	"review_reason" text,
	"reviewed_at" timestamp with time zone,
	"created_block_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_user_state" ADD CONSTRAINT "trip_user_state_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_user_state" ADD CONSTRAINT "trip_user_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_cover_asset_id_media_assets_id_fk" FOREIGN KEY ("cover_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "days" ADD CONSTRAINT "days_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_notes" ADD CONSTRAINT "trip_notes_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_notes" ADD CONSTRAINT "trip_notes_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payments" ADD CONSTRAINT "expense_payments_participant_id_trip_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_participant_id_trip_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_from_participant_id_trip_participants_id_fk" FOREIGN KEY ("from_participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_to_participant_id_trip_participants_id_fk" FOREIGN KEY ("to_participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_recorded_by_trip_participants_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."trip_participants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_claims_participant_id_trip_participants_id_fk" FOREIGN KEY ("claims_participant_id") REFERENCES "public"."trip_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_created_block_id_blocks_id_fk" FOREIGN KEY ("created_block_id") REFERENCES "public"."blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fx_lookup_idx" ON "fx_rates" USING btree ("base_currency","quote_currency","as_of");--> statement-breakpoint
CREATE INDEX "idempotency_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_owner_idx" ON "media_assets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "media_pending_idx" ON "media_assets" USING btree ("created_at") WHERE "media_assets"."state" = 'PENDING';--> statement-breakpoint
CREATE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "folders_owner_idx" ON "folders" USING btree ("owner_id","sort_order");--> statement-breakpoint
CREATE INDEX "trip_members_user_idx" ON "trip_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_owner_per_trip" ON "trip_members" USING btree ("trip_id") WHERE "trip_members"."role" = 'OWNER';--> statement-breakpoint
CREATE INDEX "trips_owner_idx" ON "trips" USING btree ("owner_id") WHERE "trips"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "trips_folder_idx" ON "trips" USING btree ("folder_id") WHERE "trips"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "trips_upcoming_idx" ON "trips" USING btree ("start_date") WHERE "trips"."deleted_at" is null and "trips"."is_archived" = false;--> statement-breakpoint
CREATE INDEX "blocks_day_idx" ON "blocks" USING btree ("day_id","sort_order") WHERE "blocks"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "blocks_confirmed_idx" ON "blocks" USING btree ("day_id","is_confirmed") WHERE "blocks"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "days_variant_number_uq" ON "days" USING btree ("variant_id","day_number");--> statement-breakpoint
CREATE INDEX "packing_trip_idx" ON "packing_items" USING btree ("trip_id","category","sort_order");--> statement-breakpoint
CREATE INDEX "variants_trip_idx" ON "variants" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_main_per_trip" ON "variants" USING btree ("trip_id") WHERE "variants"."is_main";--> statement-breakpoint
CREATE UNIQUE INDEX "payments_expense_participant_uq" ON "expense_payments" USING btree ("expense_id","participant_id");--> statement-breakpoint
CREATE INDEX "payments_participant_idx" ON "expense_payments" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "shares_participant_idx" ON "expense_shares" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "expenses_trip_idx" ON "expenses" USING btree ("trip_id","spent_at") WHERE "expenses"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "expenses_block_idx" ON "expenses" USING btree ("block_id") WHERE "expenses"."block_id" is not null and "expenses"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "settlements_trip_idx" ON "settlements" USING btree ("trip_id") WHERE "settlements"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "settlements_nudge_idx" ON "settlements" USING btree ("settled_at") WHERE "settlements"."voided_at" is null and "settlements"."confirmed_by_payee" = false;--> statement-breakpoint
CREATE INDEX "participants_trip_idx" ON "trip_participants" USING btree ("trip_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_trip_user_uq" ON "trip_participants" USING btree ("trip_id","user_id") WHERE "trip_participants"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "activity_trip_idx" ON "activity_events" USING btree ("trip_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_block_idx" ON "comments" USING btree ("block_id") WHERE "comments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "comments_trip_idx" ON "comments" USING btree ("trip_id","created_at") WHERE "comments"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_uq" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "one_pending_invite" ON "invites" USING btree ("trip_id","email") WHERE "invites"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "invites_email_idx" ON "invites" USING btree ("email") WHERE "invites"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE not "notifications"."is_read";--> statement-breakpoint
CREATE INDEX "notifications_outbox_idx" ON "notifications" USING btree ("email_state","created_at") WHERE "notifications"."email_state" in ('PENDING','BATCHED');--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_slug_uq" ON "share_links" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "one_link_per_trip" ON "share_links" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "suggestions_trip_status_idx" ON "suggestions" USING btree ("trip_id","status");