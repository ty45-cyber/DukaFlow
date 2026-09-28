import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_FILE = path.resolve(process.cwd(), 'data/store.json');
let writeQueue = Promise.resolve();

export async function readStore() {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

export async function writeStore(store) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fs.rename(tmp, DATA_FILE);
  });
  return writeQueue;
}

export async function withStore(mutator) {
  let output;
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const current = await readStore();
    output = await mutator(current);
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(current, null, 2), 'utf8');
    await fs.rename(tmp, DATA_FILE);
  });
  await writeQueue;
  return output;
}

export async function resetStore() {
  const seed = {
    business: {
      id: 'biz_demo_001', name: 'Kisumu Fresh Mart', currency: 'KES',
      deliveryZones: { CBD: 250, Westlands: 350, 'Kisumu CBD': 150, Milimani: 200 }
    },
    products: [
      {id:'SKU-SG-2L',name:'SunGold Cooking Oil 2L',aliases:['SunGold 2L','big SunGold 2 litre','cooking oil 2 litre'],priceMinor:128000,stock:8,active:true},
      {id:'SKU-SG-3L',name:'SunGold Cooking Oil 3L',aliases:['SunGold 3L','SunGold three litre','cooking oil 3 litre','big SunGold'],priceMinor:128000,stock:5,active:true},
      {id:'SKU-PM-2KG',name:'Pembe Maize Flour 2kg',aliases:['Pembe 2kg','unga 2 kilo','maize flour 2kg','unga'],priceMinor:17500,stock:30,active:true},
      {id:'SKU-WT-10L',name:'Mineral Water 10L',aliases:['water 10 litre','10L water','big water'],priceMinor:35000,stock:12,active:true},
      {id:'SKU-BB-500',name:'Blue Band 500g',aliases:['Blue Band','margarine 500g'],priceMinor:22000,stock:18,active:true}
    ], orders: [], reservations: [], events: [], voiceSessions: {}
  };
  await writeStore(seed);
  return seed;
}
