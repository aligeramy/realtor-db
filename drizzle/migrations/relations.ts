import { relations } from "drizzle-orm/relations";
import { listings, listingMedia } from "./schema";

export const listingMediaRelations = relations(listingMedia, ({one}) => ({
	listing: one(listings, {
		fields: [listingMedia.listingId],
		references: [listings.id]
	}),
}));

export const listingsRelations = relations(listings, ({many}) => ({
	listingMedias: many(listingMedia),
}));