import { describeProduct, type Product } from "../domain/product";

export function renderProduct(product: Product): string {
  return `<li>${describeProduct(product)}</li>`;
}
