import "/lib/beer.min.js";
import { createApp } from "/lib/vue.min.js";
import ReadMore from '/lib/overflow.vue.js';
import { createSetup } from '/js/app.js';
import { loadCatalog } from '/js/catalog.js';

const config = await loadCatalog();

createApp({
  setup: createSetup(config),
  components: { ReadMore },
}).mount('#app');
