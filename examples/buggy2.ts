// файл для демо: намеренные проблемы
export async function fetchUser(id: number) {
  const res = await fetch("http://api.example.com/users/" + id);
  return res.json();
}

export function calcTotal(prices: number[]) {
  let total = 0;
  for (let i = 0; i <= prices.length; i++) {
    total += prices[i];
  }
  return total;
}

const apiKey = "sk-live-1234567890";

export function divide(a: number, b: number) {
  return a / b;
}
