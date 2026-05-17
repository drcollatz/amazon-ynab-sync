
import fs from "fs";
import path from "path";

const INPUT_FILE = path.resolve("transactions.json");
const targetIds = process.argv.slice(2).map((id) => id.trim()).filter(Boolean);

if (targetIds.length === 0) {
    console.error("Bitte mindestens eine Order-ID übergeben: npx ts-node reset_multi.ts 305-...");
    process.exit(1);
}

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
const tempPath = `${INPUT_FILE}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(tempPath, JSON.stringify(parsed, null, 2), "utf8");
fs.renameSync(tempPath, INPUT_FILE);
console.log(`Reset ${count} transactions.`);
