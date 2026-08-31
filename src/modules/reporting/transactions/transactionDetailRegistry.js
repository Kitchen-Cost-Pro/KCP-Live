const REGISTRY = Object.freeze({
  grv: { label: "GRV", icon: "GRV" },
  credit_note: { label: "Credit Note", icon: "CN" },
  manufacturing_batch: { label: "Manufacturing", icon: "MFG" },
  transfer: { label: "Transfer", icon: "TRF" },
  stock_take: { label: "Stock Take", icon: "STK" },
  adjustment: { label: "Adjustment", icon: "ADJ" },
});

export function getTransactionDetailDefinition(entityType = "") {
  return REGISTRY[String(entityType || "").trim()] || {
    label: "Transaction",
    icon: "TXN",
  };
}

export function getTransactionDetailRegistry() {
  return { ...REGISTRY };
}
