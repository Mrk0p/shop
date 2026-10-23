import { z } from "zod";

export const productSchema = z.object({
  name: z.string().trim().min(1, "Product name is required"),
  description: z.string().trim().min(1, "Description is required"),
  status: z.enum(["draft", "published", "archived"]),
  // Browser form inputs are strings, so coerce the price to a number.
  price: z.coerce.number().finite().int().min(1, "Price must be at least 1"),
  // Accept the comma-separated format used by the current hidden input.
  images: z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // Fall through to support existing comma-separated form values.
        }
        return value.split(",").map((url) => url.trim()).filter(Boolean);
      }
      return value;
    },
    z.array(z.string().url()).min(1, "At least one valid image URL is required")
  ),
  category: z.enum(["men", "women", "kids"]),
  isFeatured: z.preprocess(
    (value) => value === true || value === "on" || value === "true",
    z.boolean()
  ).optional(),
});

export const bannerSchema = z.object({
  title: z.string().trim().min(1, "Banner title is required"),
  imageString: z.string().url("A valid image URL is required"),
});
