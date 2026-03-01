
import fs from "fs";
import path from "path";

const INPUT_FILE = path.resolve("transactions.json");
const targetIds = [
    "305-8458067-2556331",
    "305-9545395-6185141",
    "305-3854716-9882740"
];

const raw = fs.readFileSync(INPUT_FILE, "utf8");
const parsed = JSON.parse(raw);

console.log("Resetting all parts of the split group...");
let count = 0;
for (const t of parsed.transactions) {
    if (targetIds.includes(t.orderId)) {
        t.ynabSynced = false;
        t.ynabSync = null;
        count++;
    }
}
fs.writeFileSync(INPUT_FILE, JSON.stringify(parsed, null, 2));
console.log(`Reset ${count} transactions.`);
