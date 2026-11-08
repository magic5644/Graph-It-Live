<script setup lang="ts">
import { defineAsyncComponent, ref } from "vue";
import Child from "./Child.vue";
import ChildRow from "./ChildRow.vue";
import { format, track } from "./utils/format";

const props = defineProps<{ items: string[] }>();
const emit = defineEmits<{ save: [value: number] }>();
const LazyPanel = defineAsyncComponent(() => import("./ChildRow.vue"));
const count = ref(0);

function save(): void {
  emit("save", count.value);
}
</script>

<template>
  <section>
    <Child @save="save" @track="track" />
    <child-row v-for="format in props.items" :key="format" :label="format" />
    <button @click="save()">{{ format(count) }}</button>
    <LazyPanel />
    <Transition><GlobalWidget /></Transition>
  </section>
</template>
