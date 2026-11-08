<template>
  <span>{{ twice(2) }}</span>
</template>
<script setup>
import { add } from "./utils/index";
function twice(n) {
  return add(n, n);
}
</script>
