import type { Product } from "../domain/product";
import { createInvoice } from "../billing/invoice";

export interface Order {
  id: string;
  product: Product;
  quantity: number;
}

const orders = new Map<string, Order>();

export function placeOrder(product: Product, quantity: number): Order {
  const order = { id: `o${orders.size + 1}`, product, quantity };
  orders.set(order.id, order);
  createInvoice(order.id, product.priceCents * quantity);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}
