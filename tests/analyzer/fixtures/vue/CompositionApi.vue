<script lang="ts">
import { defineComponent } from "vue";
import { add } from "./utils/math";

export default defineComponent({
  setup() {
    const sum = () => add(2, 3);
    return { sum };
  },
});
</script>

<template>
  <p>{{ sum() }}</p>
</template>
