CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"scope" varchar(20) NOT NULL,
	"monthly_allowance" integer NOT NULL,
	"max_units_per_request" integer NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(150) NOT NULL,
	"api_key_hash" varchar(64) NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(150) NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_monthly_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"units_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_monthly_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"units_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_request_id" varchar(255) NOT NULL,
	"units_requested" integer NOT NULL,
	"units_consumed" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) NOT NULL,
	"rejection_reason" varchar(100),
	"period" varchar(7) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_monthly_usage" ADD CONSTRAINT "account_monthly_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_monthly_usage" ADD CONSTRAINT "user_monthly_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_monthly_usage" ADD CONSTRAINT "user_monthly_usage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_predefined_plan_idx" ON "plans" USING btree ("scope","name") WHERE "plans"."account_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_custom_plan_idx" ON "plans" USING btree ("scope","account_id","name") WHERE "plans"."account_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_api_key_hash_idx" ON "accounts" USING btree ("api_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_account_id_name_idx" ON "users" USING btree ("account_id","name");--> statement-breakpoint
CREATE INDEX "users_account_id_idx" ON "users" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_monthly_usage_period_idx" ON "account_monthly_usage" USING btree ("account_id","period");--> statement-breakpoint
CREATE INDEX "account_monthly_usage_account_idx" ON "account_monthly_usage" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_monthly_usage_period_idx" ON "user_monthly_usage" USING btree ("user_id","period");--> statement-breakpoint
CREATE INDEX "user_monthly_usage_account_period_idx" ON "user_monthly_usage" USING btree ("account_id","period");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_account_req_id_idx" ON "usage_records" USING btree ("account_id","client_request_id");--> statement-breakpoint
CREATE INDEX "usage_records_account_created_at_idx" ON "usage_records" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_records_account_period_idx" ON "usage_records" USING btree ("account_id","period");--> statement-breakpoint
CREATE INDEX "usage_records_user_period_idx" ON "usage_records" USING btree ("user_id","period");