import { NanoGptClient } from "./dist/client.js";
import { mapNanoGptModelsToVscode } from "./dist/nanogpt.js";

async function test() {
  const client = new NanoGptClient(fetch);
  // Just fetch to see if duplicates exist
  const res = await fetch("https://nano-gpt.com/api/v1/models?detailed=true");
  const payload = await res.json();
  const entries = payload.data || payload;
  const models = mapNanoGptModelsToVscode(entries);
  console.log("Total mapped models:", models.length);
  
  const ids = models.map(m => m.id);
  const uniqueIds = new Set(ids);
  console.log("Unique IDs:", uniqueIds.size);
}
test();
