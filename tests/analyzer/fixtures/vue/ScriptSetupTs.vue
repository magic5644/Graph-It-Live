<template>
  <div>
    <span>{{ total() }}</span>
  </div>
</template>

<script setup lang="ts">
import { add } from "@/utils";

function total(): number {
  return add(4, 5);
}
</script>
