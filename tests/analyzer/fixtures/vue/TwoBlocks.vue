<script lang="ts">
export const LIMIT = 10;
</script>

<template>
  <p>{{ capped(12) }}</p>
</template>

<script setup lang="ts">
import { add } from "./utils/math";

function capped(n: number): number {
  return Math.min(add(n, 0), LIMIT);
}
</script>
