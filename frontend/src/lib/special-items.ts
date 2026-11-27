/**
 * BackStreet: Special items. The cashier types what it is and the price; the line uses a hidden
 * "Special (kitchen)" or "Special (bar)" menu item so it prints at the right station. The typed
 * name and price ride on the cart line and are checked again by the server.
 */
import type { Product } from './types';

export const SPECIAL_ITEM_TAG = 'special_item';

export interface SpecialCustom { name: string; price: number }

export interface SpecialItemsConfig {
  enabled: boolean;
  can_add: boolean;
  kitchen: { categoryId: string; productId: string; categoryName: string } | null;
  bar: { categoryId: string; productId: string; categoryName: string } | null;
}

export function isSpecialItemProduct(product: Pick<Product, 'tags'> | null | undefined): boolean {
  return Array.isArray(product?.tags) && product!.tags!.includes(SPECIAL_ITEM_TAG);
}

/** A cart product for one Special item: the hidden item, shown with the typed name and price. */
export function specialCartProduct(hidden: Product, custom: SpecialCustom): Product {
  return { ...hidden, name: custom.name, price: custom.price, special_custom: custom };
}

/** The extra fields an order line needs when it is a Special item. */
export function specialItemFields(product: Pick<Product, 'special_custom'>): { custom_name?: string; custom_price?: number } {
  const custom = product.special_custom;
  return custom ? { custom_name: custom.name, custom_price: custom.price } : {};
}

/** Cart identity key: two different Special items never merge into one line. */
export function cartProductKey(product: { id: string | number; special_custom?: SpecialCustom }): string | number {
  const custom = product.special_custom;
  // Normal items keep their plain id, so existing cart and held-order lines are unchanged.
  return custom ? `${product.id}|special|${custom.name}|${custom.price}` : product.id;
}
