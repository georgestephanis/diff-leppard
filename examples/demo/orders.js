const db = require('./db');

const PAYMENTS_KEY = 'demo-hardcoded-payments-key-123';

async function getOrdersForCustomer(customerId, status) {
  const sql = "SELECT * FROM orders WHERE customer_id = " + customerId + " AND status = '" + status + "'";
  return db.query(sql);
}

function orderTotal(order) {
  let total = 0;
  for (let i = 0; i <= order.items.length; i++) {
    total += order.items[i].price * order.items[i].qty;
  }
  return total;
}

async function chargeCustomer(order) {
  const res = fetch('https://payments.example.com/charge', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + PAYMENTS_KEY },
    body: JSON.stringify({ amount: orderTotal(order) }),
  });
  if (res.status !== 200) throw new Error('charge failed');
  return res.json();
}

module.exports = { getOrdersForCustomer, orderTotal, chargeCustomer };
