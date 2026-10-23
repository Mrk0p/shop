"use server";

import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { redirect } from "next/navigation";
import { parseWithZod } from "@conform-to/zod";
import { bannerSchema, productSchema } from "./lib/zodSchemas";
import prisma from "./lib/db";
import { redis } from "./lib/redis";
import { Cart } from "./lib/interfaces";
import { revalidatePath } from "next/cache";
import { stripe } from "./lib/stripe";
import Stripe from "stripe";

export async function createProduct(prevState: unknown, formData: FormData) {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user || user.email !== "sachinwele23@gmail.com") {
    return redirect("/");
  }

  const submission = parseWithZod(formData, {
    schema: productSchema,
  });

  if (submission.status !== "success") {
    return submission.reply();
  }

  const flattenUrls = submission.value.images.flatMap((urlString) =>
    urlString.split(",").map((url) => url.trim())
  );

  await prisma.product.create({
    data: {
      name: submission.value.name,
      description: submission.value.description,
      status: submission.value.status,
      price: submission.value.price,
      images: flattenUrls,
      category: submission.value.category,
      isFeatured: submission.value.isFeatured === true ? true : false,
    },
  });

  redirect("/dashboard/products");
}

export async function editProduct(prevState: any, formData: FormData) {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user || user.email !== "sachinwele23@gmail.com") {
    return redirect("/");
  }

  const submission = parseWithZod(formData, {
    schema: productSchema,
  });

  if (submission.status !== "success") {
    return submission.reply();
  }

  const flattenUrls = submission.value.images.flatMap((urlString) =>
    urlString.split(",").map((url) => url.trim())
  );

  const productId = formData.get("productId") as string;
  await prisma.product.update({
    where: {
      id: productId,
    },
    data: {
      name: submission.value.name,
      description: submission.value.description,
      category: submission.value.category,
      price: submission.value.price,
      isFeatured: submission.value.isFeatured === true ? true : false,
      status: submission.value.status,
      images: flattenUrls,
    },
  });

  redirect("/dashboard/products");
}

export async function deleteProduct(formData: FormData) {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user || user.email !== "sachinwele23@gmail.com") {
    return redirect("/");
  }

  await prisma.product.delete({
    where: {
      id: formData.get("productId") as string,
    },
  });

  redirect("/dashboard/products");
}

export async function createBanner(prevState: any, formData: FormData) {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user || user.email !== "sachinwele23@gmail.com") {
    return redirect("/");
  }

  const submission = parseWithZod(formData, {
    schema: bannerSchema,
  });

  if (submission.status !== "success") {
    return submission.reply();
  }

  await prisma.banner.create({
    data: {
      title: submission.value.title,
      imageString: submission.value.imageString,
    },
  });

  redirect("/dashboard/banner");
}

export async function deleteBanner(formData: FormData) {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user || user.email !== "sachinwele23@gmail.com") {
    return redirect("/");
  }

  await prisma.banner.delete({
    where: {
      id: formData.get("bannerId") as string,
    },
  });

  redirect("/dashboard/banner");
}

export async function addItem(productId: string) {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user) {
    return redirect("/");
  }

  const selectedProduct = await prisma.product.findFirst({
    select: {
      id: true,
      name: true,
      price: true,
      images: true,
    },
    where: {
      id: productId,
      status: "published",
    },
  });

  if (!selectedProduct) {
    throw new Error("This product is not available.");
  }

  if (!Number.isSafeInteger(selectedProduct.price) || selectedProduct.price < 1) {
    throw new Error("This product has an invalid price.");
  }

  let cart: Cart | null = await redis.get(`cart-${user.id}`);
  const items = cart?.items ?? [];
  const existingItem = items.find((item) => item.id === selectedProduct.id);

  if (existingItem && (!Number.isSafeInteger(existingItem.quantity) || existingItem.quantity >= 99)) {
    throw new Error("A maximum of 99 units per product can be added.");
  }

  const updatedItems = existingItem
    ? items.map((item) =>
        item.id === selectedProduct.id
          ? { ...item, quantity: item.quantity + 1 }
          : item
      )
    : [
        ...items,
        {
          id: selectedProduct.id,
          name: selectedProduct.name,
          price: selectedProduct.price,
          imageString: selectedProduct.images[0] ?? "",
          quantity: 1,
        },
      ];

  await redis.set(`cart-${user.id}`, {
    userId: user.id,
    items: updatedItems,
  } satisfies Cart);

  revalidatePath("/", "layout");
}

export async function delItem(formData: FormData) {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user) {
    return redirect("/");
  }

  const productId = formData.get("productId");

  let cart: Cart | null = await redis.get(`cart-${user.id}`);

  if (cart && cart.items) {
    const updateCart: Cart = {
      userId: user.id,
      items: cart.items.filter((item) => item.id !== productId),
    };

    await redis.set(`cart-${user.id}`, updateCart);
  }

  revalidatePath("/bag");
}

export async function checkOut() {
  const { getUser } = getKindeServerSession();
  const user = await getUser();

  if (!user) {
    return redirect("/");
  }

  const cart: Cart | null = await redis.get(`cart-${user.id}`);

  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
    throw new Error("Your cart is empty.");
  }

  // Treat the cart as a list of product IDs and quantities only. Prices, names,
  // and images must always come from the database, never from cached cart data.
  const quantities = new Map<string, number>();
  for (const item of cart.items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 99
    ) {
      throw new Error("Your cart contains an invalid item. Please update your cart.");
    }

    const nextQuantity = (quantities.get(item.id) ?? 0) + item.quantity;
    if (nextQuantity > 99) {
      throw new Error("A maximum of 99 units per product can be checked out.");
    }
    quantities.set(item.id, nextQuantity);
  }

  const products = await prisma.product.findMany({
    where: {
      id: { in: [...quantities.keys()] },
      status: "published",
    },
    select: {
      id: true,
      name: true,
      price: true,
      images: true,
    },
  });

  if (products.length !== quantities.size) {
    throw new Error("One or more products are no longer available. Please update your cart.");
  }

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = products.map((product) => {
    if (!Number.isSafeInteger(product.price) || product.price < 1) {
      throw new Error("A product has an invalid price and cannot be checked out.");
    }

    return {
      price_data: {
        // Product prices in the store are displayed in rupees; Stripe expects paise.
        currency: "inr",
        unit_amount: product.price * 100,
        product_data: {
          name: product.name,
          ...(product.images[0] ? { images: [product.images[0]] } : {}),
        },
      },
      quantity: quantities.get(product.id)!,
    };
  });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: lineItems,
    success_url:
      process.env.NODE_ENV === "development"
        ? "http://localhost:3000/payment/success"
        : "https://shop-seven-orcin.vercel.app/payment/success",
    cancel_url:
      process.env.NODE_ENV === "development"
        ? "http://localhost:3000/payment/cancel"
        : "https://shop-seven-orcin.vercel.app/payment/cancel",
    metadata: {
      userId: user.id,
    },
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL.");
  }

  return redirect(session.url);
}
