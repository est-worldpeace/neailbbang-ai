CREATE TABLE `bakery_forecasts` (
	`id` text PRIMARY KEY NOT NULL,
	`space` text NOT NULL,
	`product_id` text NOT NULL,
	`target` text NOT NULL,
	`payload` text NOT NULL,
	`issued_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `forecast_space_product_target` ON `bakery_forecasts` (`space`,`product_id`,`target`);--> statement-breakpoint
CREATE INDEX `forecast_space_target` ON `bakery_forecasts` (`space`,`target`);--> statement-breakpoint
CREATE TABLE `bakery_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`space` text NOT NULL,
	`product_id` text NOT NULL,
	`target` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_space_product_target` ON `bakery_plans` (`space`,`product_id`,`target`);--> statement-breakpoint
CREATE TABLE `bakery_products` (
	`id` text PRIMARY KEY NOT NULL,
	`space` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_space_name` ON `bakery_products` (`space`,`name`);--> statement-breakpoint
CREATE TABLE `bakery_records` (
	`id` text PRIMARY KEY NOT NULL,
	`space` text NOT NULL,
	`product_id` text NOT NULL,
	`date` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_space_product_date` ON `bakery_records` (`space`,`product_id`,`date`);--> statement-breakpoint
CREATE INDEX `record_space_date` ON `bakery_records` (`space`,`date`);