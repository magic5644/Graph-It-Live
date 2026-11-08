<script lang="ts">
export const CHILD_VERSION = 1;
</script>

<script setup lang="ts">
const row = { id: 1 };
</script>

<template>
  <slot :row="row" />
</template>
