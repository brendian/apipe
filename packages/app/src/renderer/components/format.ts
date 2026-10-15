export const dollars = (n: number): string => `$${n.toFixed(2)}`;

/** "$1.10 of $8.00", or just "$1.10" when the budget isn't known. */
export function costText(cost: number, budget: number | null): string {
  return budget === null ? dollars(cost) : `${dollars(cost)} of ${dollars(budget)}`;
}
