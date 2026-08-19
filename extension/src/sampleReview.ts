import { DiffFile } from '../../src/types';

export const SAMPLE_DIFF = `diff --git a/codescout-sample.ts b/codescout-sample.ts
new file mode 100644
--- /dev/null
+++ b/codescout-sample.ts
@@ -0,0 +1,16 @@
+export async function loadUser(id: string) {
+  try {
+    return await db.users.findById(id);
+  } catch (e) {}
+}
+
+export function connect() {
+  const password = "secret123";
+  return db.connect({ password });
+}
+
+export function findUser(name: string) {
+  const query = "SELECT * FROM users WHERE name = '" + name + "'";
+  return db.query(query);
+}
+`;

export const SAMPLE_FILE: DiffFile = {
  filename: 'codescout-sample.ts',
  status: 'added',
  additions: 14,
  deletions: 0,
  patch: SAMPLE_DIFF
};

export const SAMPLE_EXPECTED_BUGS = 3;

export function sampleTestSummary(found: number): string {
  return `Пример: ожидалось 2-3 бага, найдено ${found}. ${found === 0 ? '⚠️ Модель слишком слабая для ревью — смени модель кнопкой ⚙️' : 'Ревьюер жив!'}`;
}
