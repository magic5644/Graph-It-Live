import { describeProduct, type Product } from "../domain/product";

export function printDailyReport(products: Product[]): void {
  for (const product of products) console.log(describeProduct(product));
}
