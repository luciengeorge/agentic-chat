// 👨‍💼 Before we trust the course to grade real work, we check it on something tiny: a greeting.

export function formatGreeting(name: string): string {
  // 🐨 Return "hello " followed by the name.
  // 💰 A template literal does it: `hello ${name}`
  // 🦉 The test imports `#learn/_sample/greeting`, not this file. While this step is active, the slot
  //    plugin points that import at your copy in playground/, so the test grades the code you edit.
  // 📜 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals
  // 🚨 The tests call this with a few names and check the exact string.
  throw new Error(`formatGreeting("${name}") isn't written yet`);
}
