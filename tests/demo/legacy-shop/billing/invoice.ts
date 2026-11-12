import { getOrder } from "../orders/service";

export function createInvoice(orderId: string, totalCents: number): string {
  return `INV-${orderId}-${totalCents}`;
}

export function reprintInvoice(orderId: string): string | undefined {
  const order = getOrder(orderId);
  return order && createInvoice(order.id, order.product.priceCents * order.quantity);
}
