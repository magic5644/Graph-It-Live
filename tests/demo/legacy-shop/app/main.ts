import { renderProduct } from "../ui/render";
import { placeOrder } from "../orders/service";
import { slugify } from "../utils/helpers";

const product = { id: "p1", name: "Desk lamp", priceCents: 4999 };

console.log(slugify(product.name), renderProduct(product));
placeOrder(product, 2);
