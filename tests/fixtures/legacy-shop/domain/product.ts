import { formatPrice } from "../ui/format";

export interface Product {
  id: string;
  name: string;
  priceCents: number;
}

export function describeProduct(product: Product): string {
  return `${product.name} (${formatPrice(product.priceCents)})`;
}
