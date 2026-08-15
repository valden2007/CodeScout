// тестовый файл для прогона codescout
export function getUserAge(user: any) {
  return new Date().getFullYear() - user.birthYear;
}

export function divide(a: number, b: number) {
  return a / b;
}

const dbPassword = "supersecret123";
