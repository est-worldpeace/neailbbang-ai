import {sqliteTable,text,index,uniqueIndex} from "drizzle-orm/sqlite-core";
export const bakeryProducts=sqliteTable("bakery_products",{
 id:text("id").primaryKey(),space:text("space").notNull(),name:text("name").notNull(),payload:text("payload").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[uniqueIndex("product_space_name").on(t.space,t.name)]);
export const bakeryRecords=sqliteTable("bakery_records",{
 id:text("id").primaryKey(),space:text("space").notNull(),productId:text("product_id").notNull(),date:text("date").notNull(),payload:text("payload").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[uniqueIndex("record_space_product_date").on(t.space,t.productId,t.date),index("record_space_date").on(t.space,t.date)]);
export const bakeryForecasts=sqliteTable("bakery_forecasts",{
 id:text("id").primaryKey(),space:text("space").notNull(),productId:text("product_id").notNull(),target:text("target").notNull(),payload:text("payload").notNull(),issuedAt:text("issued_at").notNull(),
},t=>[uniqueIndex("forecast_space_product_target").on(t.space,t.productId,t.target),index("forecast_space_target").on(t.space,t.target)]);
export const bakeryPlans=sqliteTable("bakery_plans",{
 id:text("id").primaryKey(),space:text("space").notNull(),productId:text("product_id").notNull(),target:text("target").notNull(),payload:text("payload").notNull(),updatedAt:text("updated_at").notNull(),
},t=>[uniqueIndex("plan_space_product_target").on(t.space,t.productId,t.target)]);
