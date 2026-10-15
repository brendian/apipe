import assert from "node:assert/strict";
import { test } from "node:test";

import { mean, safeDiv } from "../mathutils/index.js";

test("safeDiv divides", () => {
  assert.equal(safeDiv(6, 3), 2);
});

test("safeDiv by zero returns the fallback", () => {
  assert.equal(safeDiv(1, 0, -1), -1);
});

test("mean", () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test("mean of nothing throws", () => {
  assert.throws(() => mean([]), /values/);
});
