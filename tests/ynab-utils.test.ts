import assert from "node:assert/strict";
import test from "node:test";
import {
  amountToMilliunits,
  mergeTransactions,
  parseGermanDateToISO,
  parseIdList,
  sortTransactionsNewestFirst,
  transactionKey,
  transactionTime,
  type TransactionLike
} from "../ynab-utils";

test("parseIdList accepts JSON arrays and comma-separated lists", () => {
  assert.deepEqual(parseIdList('["111-222","333-444"]'), ["111-222", "333-444"]);
  assert.deepEqual(parseIdList("111-222, 333-444 ,, 555-666"), ["111-222", "333-444", "555-666"]);
  assert.deepEqual(parseIdList(undefined), []);
});

test("parseGermanDateToISO parses German month names with umlauts", () => {
  assert.equal(parseGermanDateToISO("7. März 2024"), "2024-03-07");
  assert.equal(parseGermanDateToISO("31. Dezember 2023"), "2023-12-31");
  assert.equal(parseGermanDateToISO("kein Datum"), null);
});

test("amountToMilliunits handles German and English formats", () => {
  assert.equal(amountToMilliunits("19,94 €", false), -19940);
  assert.equal(amountToMilliunits("+19,94 €", false), 19940);
  assert.equal(amountToMilliunits("1.234,56 €", false), -1234560);
  assert.equal(amountToMilliunits("1,234.56 €", false), -1234560);
  assert.equal(amountToMilliunits("19.94", true), 19940);
});

test("transactionTime handles March umlaut dates", () => {
  assert.ok(transactionTime({ date: "31. März 2026" }) > transactionTime({ date: "16. Februar 2026" }));
});

test("sortTransactionsNewestFirst keeps March between April and February", () => {
  const sorted = sortTransactionsNewestFirst([
    { date: "16. Februar 2026", orderId: "feb", amount: "-€1.00" },
    { date: "31. März 2026", orderId: "mar", amount: "-€1.00" },
    { date: "08. April 2026", orderId: "apr", amount: "-€1.00" }
  ]);

  assert.deepEqual(sorted.map((item) => item.orderId), ["apr", "mar", "feb"]);
});

test("transactionKey differentiates same order charges and refunds", () => {
  assert.notEqual(
    transactionKey({ date: "13. März 2026", orderId: "305-1", amount: "+€5.80" }),
    transactionKey({ date: "07. März 2026", orderId: "305-1", amount: "-€5.80" })
  );
});

test("mergeTransactions preserves older unsynced months when syncing newer entries", () => {
  const existing: TransactionLike[] = [
    { date: "31. März 2026", orderId: "march", amount: "-€8.41", orderDescription: "existing march" },
    { date: "16. Februar 2026", orderId: "feb", amount: "-€47.70", ynabSynced: true }
  ];
  const incoming: TransactionLike[] = [
    { date: "27. April 2026", orderId: "april", amount: "-€11.47", orderDescription: "new april" }
  ];

  const result = mergeTransactions(existing, incoming);

  assert.equal(result.transactions.length, 3);
  assert.deepEqual(result.transactions.map((item) => item.orderId), ["april", "march", "feb"]);
  assert.deepEqual(result.newTransactions.map((item) => item.orderId), ["april"]);
});

test("mergeTransactions updates repeated entries instead of duplicating them", () => {
  const existing = [
    { date: "27. April 2026", orderId: "april", amount: "-€11.47", orderDescription: "old" }
  ];
  const incoming = [
    { date: "27. April 2026", orderId: "april", amount: "-€11.47", orderDescription: "fresh" }
  ];

  const result = mergeTransactions(existing, incoming);

  assert.equal(result.transactions.length, 1);
  assert.equal(result.newTransactions.length, 0);
  assert.equal(result.transactions[0].orderDescription, "fresh");
});

test("mergeTransactions lets new refunds inherit details from the original order", () => {
  const existing: TransactionLike[] = [
    {
      date: "16. Februar 2026",
      orderId: "028-1747135-4689953",
      amount: "-€47.70",
      orderDescription: "2x Alf Loose Girlie",
      orderItems: [{ title: "Alf Loose Girlie", price: "19,90€" }]
    }
  ];
  const incoming: TransactionLike[] = [
    {
      date: "02. März 2026",
      orderId: "028-1747135-4689953",
      amount: "+€19.90"
    }
  ];

  const result = mergeTransactions(existing, incoming);
  const refund = result.transactions.find((transaction) => transaction.amount === "+€19.90");

  assert.equal(refund?.orderDescription, "2x Alf Loose Girlie");
  assert.deepEqual(refund?.orderItems, [{ title: "Alf Loose Girlie", price: "19,90€" }]);
});
