<template>
  <button @click="run">{{ label }}</button>
</template>

<script>
import { add } from "./utils/math";

export default {
  name: "OptionsApi",
  methods: {
    run() {
      return add(1, 2);
    },
  },
};
</script>
