CREATE TABLE "geocode_cache" (
	"address" text PRIMARY KEY NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"created_at" timestamp DEFAULT now(),
	"last_access" timestamp DEFAULT now(),
	"access_count" integer DEFAULT 1
);
--> statement-breakpoint
ALTER TABLE "listing_media" ALTER COLUMN "listing_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "bathrooms_total" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "list_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "expiration_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "close_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "replication_state" ALTER COLUMN "id" SET DATA TYPE serial;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "state_or_province" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "standardized_address" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "addressstandardized" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "formattedaddress" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "geocodingfailed" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "location" geometry(point);--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "bathrooms_total_integer" integer;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "media_change_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "listing_key" text;