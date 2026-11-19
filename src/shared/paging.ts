/** An offset past the last item is an error naming the item count, never an empty page (#769). */
export function assertOffsetInRange(offset: number, total: number, items: string): void {
  if (offset > 0 && offset >= total) {
    throw new RangeError(`offset ${offset} is past the end: ${total} ${items}${total > 0 ? `, last offset ${total - 1}` : ""}.`);
  }
}
