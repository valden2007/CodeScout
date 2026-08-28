export function divide(a: number, b: number) {
  return a / b;
}

const secretKey = "sk-prod-abc123";

export function processArray(items: number[]) {
  for (let i = 0; i <= items.length; i++) {
    console.log(items[i]);
  }
}
